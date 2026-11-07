import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/store.ts";
import type { CoinSymbol } from "../src/coins.ts";
import type { HistoryPoint, Snapshot } from "../src/types.ts";

let dir: string;
let file: string;
let historyFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coinalyze-store-"));
  file = join(dir, "funding_rate.json");
  historyFile = join(dir, "history.sqlite");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const snap = (symbol: CoinSymbol, timestamp: number, rate = 0.01): Snapshot => ({
  type: "snapshot",
  symbol,
  coin: symbol === "ETH" ? "ethereum" : "bitcoin",
  timestamp,
  aggregated_predicted_funding_rate: rate,
  oi_weighted_predicted_funding_rate: null,
  markets: 1,
  open_interest_usd: null,
  unit: "percent_per_8h",
  components: [
    {
      venue: "BINANCE USDT",
      symbol: `${symbol}USDT_PERP.A`,
      predicted_rate: rate,
      rate_period_hours: 8,
      rate_8h: rate,
      oi_usd: null,
      updated_at: timestamp,
      status: "used",
    },
  ],
});

test("a corrupt or v1-format file starts empty", async () => {
  await Bun.write(file, "{not json");
  const corrupt = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  await corrupt.load();
  expect(corrupt.latest()).toEqual([]);

  await Bun.write(file, JSON.stringify({ aggregated_predicted_funding_rate: 0.01, coin: "ethereum" }));
  const v1 = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  await v1.load();
  expect(v1.latest()).toEqual([]);
});

test("history is capped per coin, merged ascending, and drops the per-market breakdown", async () => {
  const store = new SnapshotStore({ file, historyFile, historyLimit: 2 });
  await store.add([snap("ETH", 1), snap("ETH", 3), snap("BTC", 2)]);
  await store.add([snap("ETH", 5)]);
  const history = store.history();
  expect(history.map((p) => `${p.symbol}@${p.timestamp}`)).toEqual(["BTC@2", "ETH@3", "ETH@5"]);
  expect(history.every((p) => !("components" in p))).toBe(true);
  expect(store.latest().find((s) => s.symbol === "ETH")!.components).toHaveLength(1);
});

test("latest() is persisted and re-seeded by load(), skipping invalid entries", async () => {
  const store = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  const received: Snapshot[] = [];
  store.subscribe((s) => received.push(s));
  await store.add([snap("ETH", 1, 0.02), snap("BTC", 2, 0.03)]);
  expect(received.map((s) => s.timestamp)).toEqual([1, 2]);

  const persisted = JSON.parse(await Bun.file(file).text());
  expect(persisted).toEqual(store.latest());

  await Bun.write(file, JSON.stringify([...persisted, { ...snap("ETH", 3), symbol: "DOGE" }]));
  const reloaded = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  await reloaded.load();
  expect(reloaded.latest()).toEqual(store.latest());
  expect(reloaded.history().map((p) => p.timestamp)).toEqual([1, 2]);
});

test("load() skips snapshots whose components are malformed", async () => {
  await Bun.write(
    file,
    JSON.stringify([snap("BTC", 1), { ...snap("ETH", 2), components: [null] }, { ...snap("ETH", 3), components: [{ venue: "X" }] }]),
  );
  const store = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  await store.load();
  expect(store.latest()).toEqual([snap("BTC", 1)]);
});

test("snapshots and points written before open_interest_usd existed load with it as null", async () => {
  const { open_interest_usd: _, ...old } = snap("ETH", 1);
  const { components: __, ...oldPoint } = old;
  await Bun.write(file, JSON.stringify([old]));
  const db = new Database(historyFile, { create: true });
  db.run("CREATE TABLE history (symbol TEXT NOT NULL, timestamp INTEGER NOT NULL, point TEXT NOT NULL, PRIMARY KEY (symbol, timestamp)) WITHOUT ROWID");
  db.run("INSERT INTO history VALUES ('ETH', 1, ?)", [JSON.stringify(oldPoint)]);
  db.close();

  const store = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  await store.load();
  expect(store.latest()).toEqual([snap("ETH", 1)]);
  const { components: ___, ...point } = snap("ETH", 1);
  expect(store.history()).toEqual([point]);
  expect([...store.range("ETH", 0, 2)].flat()).toEqual([point]);
});

test("a DATA_FILE write failure still publishes to subscribers and rejects add()", async () => {
  // The data file's parent is a regular file, so every write under it fails.
  const blocker = join(dir, "blocker");
  await Bun.write(blocker, "");
  const store = new SnapshotStore({ file: join(blocker, "funding_rate.json"), historyFile, historyLimit: 10 });
  const received: number[] = [];
  store.subscribe((s) => received.push(s.timestamp));
  await expect(store.add([snap("ETH", 1)])).rejects.toThrow();
  expect(received).toEqual([1]);
  expect(store.history().map((p) => p.timestamp)).toEqual([1]);
});

test("history survives a restart: memory keeps the newest points per coin, the DB keeps every point", async () => {
  const before = new SnapshotStore({ file, historyFile, historyLimit: 2 });
  await before.add([snap("ETH", 1), snap("ETH", 3), snap("BTC", 2)]);
  await before.add([snap("ETH", 5)]);

  const after = new SnapshotStore({ file, historyFile, historyLimit: 2 });
  await after.load();
  const history = after.history();
  expect(history.map((p) => `${p.symbol}@${p.timestamp}`)).toEqual(["BTC@2", "ETH@3", "ETH@5"]);
  expect(history.every((p) => !("components" in p))).toBe(true);
  expect(after.latest()).toEqual(before.latest());

  const db = new Database(historyFile, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS n FROM history WHERE symbol = 'ETH'").get()).toEqual({ n: 3 });
  db.close();
});

test("retention deletes a coin's points older than the window before its newest point", async () => {
  const store = new SnapshotStore({ file, historyFile, historyLimit: 10, historyRetentionMs: 100 });
  await store.add([snap("ETH", 1), snap("BTC", 1)]);
  await store.add([snap("ETH", 101)]);
  const timestamps = (symbol: CoinSymbol) => [...store.range(symbol, 0, Number.MAX_SAFE_INTEGER)].flat().map((p) => p.timestamp);
  // Exactly one window old is kept.
  expect(timestamps("ETH")).toEqual([1, 101]);

  await store.add([snap("ETH", 150)]);
  expect(timestamps("ETH")).toEqual([101, 150]);
  // A coin without a new point keeps its old points.
  expect(timestamps("BTC")).toEqual([1]);
});

test("range() reads one coin's points with from ≤ timestamp < to from the DB, ascending, across pages", async () => {
  const store = new SnapshotStore({ file, historyFile, historyLimit: 1 });
  await store.add([snap("ETH", 1), snap("BTC", 2)]);
  for (const t of [3, 5, 7, 9]) await store.add([snap("ETH", t)]);

  const read = (from: number, to: number) => [...store.range("ETH", from, to, 2)].flat().map((p) => p.timestamp);
  expect(read(0, Number.MAX_SAFE_INTEGER)).toEqual([1, 3, 5, 7, 9]);
  expect(read(3, 9)).toEqual([3, 5, 7]);
  expect(read(10, 20)).toEqual([]);
});

test("addBackfill stores rebuilt points between live ones; a live point at the same timestamp wins", async () => {
  const store = new SnapshotStore({ file, historyFile, historyLimit: 3 });
  await store.add([snap("ETH", 1)]);
  await store.add([snap("ETH", 10)]);
  const { components: _, ...live } = snap("ETH", 10);
  const rebuilt = (timestamp: number) => ({ ...live, timestamp, aggregated_predicted_funding_rate: 0.5, source: "backfill" as const });
  store.addBackfill([rebuilt(4), rebuilt(7), rebuilt(10)]);

  const describe = (points: HistoryPoint[]) => points.map((p) => `${p.timestamp}:${p.source ?? "live"}`);
  // Memory keeps the newest 3; the DB keeps all four.
  expect(describe(store.history())).toEqual(["4:backfill", "7:backfill", "10:live"]);
  expect(describe([...store.range("ETH", 0, 100)].flat())).toEqual(["1:live", "4:backfill", "7:backfill", "10:live"]);

  const reloaded = new SnapshotStore({ file, historyFile, historyLimit: 10 });
  await reloaded.load();
  expect(describe(reloaded.history())).toEqual(["1:live", "4:backfill", "7:backfill", "10:live"]);
});

test("addBackfill passes the rebuilt points memory keeps to backfill subscribers, never to snapshot subscribers", async () => {
  const store = new SnapshotStore({ file, historyFile, historyLimit: 3 });
  const snapshots: number[] = [];
  const backfilled: number[][] = [];
  store.subscribe((s) => snapshots.push(s.timestamp));
  store.subscribeBackfill((points) => backfilled.push(points.map((p) => p.timestamp)));
  await store.add([snap("ETH", 1)]);
  await store.add([snap("ETH", 10)]);
  const { components: _, ...live } = snap("ETH", 10);
  const rebuilt = (timestamp: number) => ({ ...live, timestamp, aggregated_predicted_funding_rate: 0.5, source: "backfill" as const });

  // 10 is live, so it is not sent.
  store.addBackfill([rebuilt(4), rebuilt(7), rebuilt(10)]);
  // Older than the 3 points memory keeps: stored, not sent.
  store.addBackfill([rebuilt(2)]);

  expect(snapshots).toEqual([1, 10]);
  expect(backfilled).toEqual([[4, 7]]);
});
