import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { COIN_REGISTRY, isCoinSymbol, type CoinSymbol } from "./coins.ts";
import { createLogger } from "./log.ts";
import type { ComponentStatus, HistoryPoint, MarketComponent, Snapshot } from "./types.ts";

const log = createLogger("store");

const isNullableNumber = (v: unknown) => v === null || Number.isFinite(v);

const isHistoryPoint = (value: unknown): value is HistoryPoint => {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.type === "snapshot" &&
    typeof s.symbol === "string" &&
    isCoinSymbol(s.symbol) &&
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.aggregated_predicted_funding_rate) &&
    (s.open_interest_usd === undefined || isNullableNumber(s.open_interest_usd)) &&
    (s.source === undefined || s.source === "backfill")
  );
};

/** Snapshots and points written before v4.2 have no `open_interest_usd`. */
const withOpenInterest = <T extends HistoryPoint>(p: T): T =>
  (p as Partial<HistoryPoint>).open_interest_usd === undefined ? { ...p, open_interest_usd: null } : p;

const COMPONENT_STATUSES: ReadonlySet<ComponentStatus> = new Set(["used", "stale", "no_rate", "unlisted"]);

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

/**
 * Latest snapshot per coin (persisted to `file`) plus the history of aggregate points: every point in
 * `historyFile` (or those within `historyRetentionMs` of a coin's newest point), the newest `historyLimit`
 * per coin in memory.
 */
export class SnapshotStore {
  private readonly file: string;
  private readonly historyFile: string;
  private readonly historyLimit: number;
  private readonly db: Database;
  private readonly appendHistory: (points: HistoryPoint[]) => void;
  private readonly insertBackfill: (points: HistoryPoint[]) => void;
  private readonly latestByCoin = new Map<string, Snapshot>();
  private readonly historyByCoin = new Map<string, HistoryPoint[]>();
  private readonly subscribers: ((s: Snapshot) => void)[] = [];

  /** Throws if `historyFile` cannot be opened or created as a SQLite database. */
  constructor(opts: { file: string; historyFile: string; historyLimit: number; historyRetentionMs?: number }) {
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
    const prune = this.db.query<never, { symbol: string; cutoff: number }>(
      "DELETE FROM history WHERE symbol = $symbol AND timestamp < $cutoff",
    );
    const retentionMs = opts.historyRetentionMs;
    this.appendHistory = this.db.transaction((points: HistoryPoint[]) => {
      const newest = new Map<string, number>();
      for (const p of points) {
        insert.run({ symbol: p.symbol, timestamp: p.timestamp, point: JSON.stringify(p) });
        newest.set(p.symbol, Math.max(newest.get(p.symbol) ?? p.timestamp, p.timestamp));
      }
      if (retentionMs === undefined) return;
      // Measured from the coin's newest point, so a stopped service keeps its archive until it polls again.
      for (const [symbol, timestamp] of newest) prune.run({ symbol, cutoff: timestamp - retentionMs });
    });
    const insertIfAbsent = this.db.query<never, { symbol: string; timestamp: number; point: string }>(
      "INSERT OR IGNORE INTO history (symbol, timestamp, point) VALUES ($symbol, $timestamp, $point)",
    );
    this.insertBackfill = this.db.transaction((points: HistoryPoint[]) => {
      for (const p of points) insertIfAbsent.run({ symbol: p.symbol, timestamp: p.timestamp, point: JSON.stringify(p) });
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

  /**
   * Rebuilt points for a gap: written to `historyFile` and merged into memory, never sent to subscribers.
   * A point already stored at the same timestamp wins.
   */
  addBackfill(points: HistoryPoint[]): void {
    this.insertBackfill(points);
    for (const symbol of new Set(points.map((p) => p.symbol))) {
      const current = this.historyByCoin.get(symbol) ?? [];
      const taken = new Set(current.map((p) => p.timestamp));
      const added = points.filter((p) => p.symbol === symbol && !taken.has(p.timestamp));
      const merged = [...current, ...added].sort((a, b) => a.timestamp - b.timestamp);
      this.historyByCoin.set(symbol, merged.slice(-this.historyLimit));
    }
  }

  latest(): Snapshot[] {
    return [...this.latestByCoin.values()];
  }

  /** All coins, ascending by timestamp. */
  history(): HistoryPoint[] {
    return [...this.historyByCoin.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * One coin's points with `from` ≤ timestamp < `to` from `historyFile`, ascending, `pageSize` rows per
   * query. Each page is a separate query, so writes between pages are safe.
   */
  *range(symbol: CoinSymbol, from: number, to: number, pageSize = 1000): Generator<HistoryPoint[]> {
    const page = this.db.query<{ timestamp: number; point: string }, { symbol: string; from: number; to: number; limit: number }>(
      `SELECT timestamp, point FROM history
       WHERE symbol = $symbol AND timestamp >= $from AND timestamp < $to
       ORDER BY timestamp LIMIT $limit`,
    );
    for (let start = from; ; ) {
      const rows = page.all({ symbol, from: start, to, limit: pageSize });
      if (rows.length === 0) return;
      yield this.parsePoints(rows).points;
      if (rows.length < pageSize) return;
      start = rows.at(-1)!.timestamp + 1;
    }
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
      if (isSnapshot(entry)) this.latestByCoin.set(entry.symbol, withOpenInterest(entry));
    }
  }

  /** Reads only the newest `historyLimit` rows per coin, so startup cost does not grow with the archive. */
  private loadHistory(): void {
    const newest = this.db.query<{ timestamp: number; point: string }, { symbol: string; limit: number }>(
      "SELECT timestamp, point FROM history WHERE symbol = $symbol ORDER BY timestamp DESC LIMIT $limit",
    );
    let skipped = 0;
    for (const symbol of Object.keys(COIN_REGISTRY)) {
      const parsed = this.parsePoints(newest.all({ symbol, limit: this.historyLimit }).reverse());
      for (const point of parsed.points) this.pushHistory(point);
      skipped += parsed.skipped;
    }
    if (skipped > 0) log.warn(`skipped ${skipped} unreadable history rows in ${this.historyFile}`);
  }

  private parsePoints(rows: { point: string }[]): { points: HistoryPoint[]; skipped: number } {
    const points: HistoryPoint[] = [];
    for (const row of rows) {
      let point: unknown;
      try {
        point = JSON.parse(row.point);
      } catch {
        point = undefined;
      }
      if (isHistoryPoint(point)) points.push(withOpenInterest(point));
    }
    return { points, skipped: rows.length - points.length };
  }

  private pushHistory(point: HistoryPoint): void {
    const history = this.historyByCoin.get(point.symbol) ?? [];
    history.push(point);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    this.historyByCoin.set(point.symbol, history);
  }
}
