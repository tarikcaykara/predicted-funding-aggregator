import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { isCoinSymbol } from "./coins.ts";
import { createLogger } from "./log.ts";
import type { ComponentStatus, HistoryPoint, MarketComponent, Snapshot } from "./types.ts";

const log = createLogger("store");

const isHistoryPoint = (value: unknown): value is HistoryPoint => {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.type === "snapshot" &&
    typeof s.symbol === "string" &&
    isCoinSymbol(s.symbol) &&
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.aggregated_predicted_funding_rate)
  );
};

const COMPONENT_STATUSES: ReadonlySet<ComponentStatus> = new Set(["used", "stale", "no_rate", "unlisted"]);
const isNullableNumber = (v: unknown) => v === null || Number.isFinite(v);

const isComponent = (value: unknown): value is MarketComponent => {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.venue === "string" &&
    (c.symbol === null || typeof c.symbol === "string") &&
    isNullableNumber(c.predicted_rate) &&
    Number.isFinite(c.rate_period_hours) &&
    isNullableNumber(c.rate_8h) &&
    isNullableNumber(c.oi_usd) &&
    isNullableNumber(c.updated_at) &&
    COMPONENT_STATUSES.has(c.status as ComponentStatus)
  );
};

const isSnapshot = (value: unknown): value is Snapshot => {
  if (!isHistoryPoint(value)) return false;
  const components = (value as Record<string, unknown>).components;
  return Array.isArray(components) && components.every(isComponent);
};

/** Latest snapshot per coin (persisted to `file`) plus a bounded history of aggregate points (persisted to `historyFile`). */
export class SnapshotStore {
  private readonly file: string;
  private readonly historyFile: string;
  private readonly historyLimit: number;
  private readonly db: Database;
  private readonly appendHistory: (points: HistoryPoint[]) => void;
  private readonly latestByCoin = new Map<string, Snapshot>();
  private readonly historyByCoin = new Map<string, HistoryPoint[]>();
  private readonly subscribers: ((s: Snapshot) => void)[] = [];

  /** Throws if `historyFile` cannot be opened or created as a SQLite database. */
  constructor(opts: { file: string; historyFile: string; historyLimit: number }) {
    this.file = opts.file;
    this.historyFile = opts.historyFile;
    this.historyLimit = opts.historyLimit;
    this.db = new Database(opts.historyFile, { create: true, strict: true });
    this.db.run(
      `CREATE TABLE IF NOT EXISTS history (
        symbol TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        point TEXT NOT NULL,
        PRIMARY KEY (symbol, timestamp)
      ) WITHOUT ROWID`,
    );
    const insert = this.db.query<never, { symbol: string; timestamp: number; point: string }>(
      "INSERT OR REPLACE INTO history (symbol, timestamp, point) VALUES ($symbol, $timestamp, $point)",
    );
    // Keeps the newest `limit` rows of a coin; with ≤ limit rows the subquery is NULL and nothing is deleted.
    const prune = this.db.query<never, { symbol: string; limit: number }>(
      `DELETE FROM history WHERE symbol = $symbol AND timestamp <= (
        SELECT timestamp FROM history WHERE symbol = $symbol ORDER BY timestamp DESC LIMIT 1 OFFSET $limit
      )`,
    );
    this.appendHistory = this.db.transaction((points: HistoryPoint[]) => {
      for (const p of points) insert.run({ symbol: p.symbol, timestamp: p.timestamp, point: JSON.stringify(p) });
      for (const symbol of new Set(points.map((p) => p.symbol))) prune.run({ symbol, limit: this.historyLimit });
    });
  }

  async load(): Promise<void> {
    await this.loadLatest();
    this.loadHistory();
  }

  /**
   * Subscribers get the snapshots before SQLite and `file` are written, so a persistence error still
   * reaches live clients; it then rejects, and the loop counts the cycle as failed.
   */
  async add(snaps: Snapshot[]): Promise<void> {
    const points: HistoryPoint[] = [];
    for (const s of snaps) {
      this.latestByCoin.set(s.symbol, s);
      const { components: _, ...point } = s;
      this.pushHistory(point);
      points.push(point);
    }
    for (const s of snaps) {
      for (const fn of this.subscribers) fn(s);
    }
    this.appendHistory(points);
    // Same-directory rename is atomic, so a crash mid-write never truncates `file`.
    const tmp = `${this.file}.tmp`;
    await Bun.write(tmp, JSON.stringify(this.latest(), null, 2));
    await rename(tmp, this.file);
  }

  latest(): Snapshot[] {
    return [...this.latestByCoin.values()];
  }

  /** All coins, ascending by timestamp. */
  history(): HistoryPoint[] {
    return [...this.historyByCoin.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  subscribe(fn: (s: Snapshot) => void): void {
    this.subscribers.push(fn);
  }

  /** Seeds only `latest()`; history comes from `historyFile`, so it isn't duplicated on restart. */
  private async loadLatest(): Promise<void> {
    const file = Bun.file(this.file);
    if (!(await file.exists())) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      log.warn(`ignoring unreadable ${this.file}`);
      return;
    }
    for (const entry of parsed) {
      if (isSnapshot(entry)) this.latestByCoin.set(entry.symbol, entry);
    }
  }

  private loadHistory(): void {
    let skipped = 0;
    // Ascending, so the in-memory cap keeps the newest `historyLimit` points per coin.
    for (const row of this.db.query<{ point: string }, []>("SELECT point FROM history ORDER BY timestamp").all()) {
      let point: unknown;
      try {
        point = JSON.parse(row.point);
      } catch {
        point = undefined;
      }
      if (isHistoryPoint(point)) this.pushHistory(point);
      else skipped++;
    }
    if (skipped > 0) log.warn(`skipped ${skipped} unreadable history rows in ${this.historyFile}`);
  }

  private pushHistory(point: HistoryPoint): void {
    const history = this.historyByCoin.get(point.symbol) ?? [];
    history.push(point);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    this.historyByCoin.set(point.symbol, history);
  }
}
