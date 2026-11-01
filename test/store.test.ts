import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/store.ts";
import type { CoinSymbol } from "../src/coins.ts";
import type { Snapshot } from "../src/types.ts";

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

test("history survives a restart, capped per coin in memory and on disk", async () => {
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
  expect(db.query("SELECT COUNT(*) AS n FROM history WHERE symbol = 'ETH'").get()).toEqual({ n: 2 });
  db.close();
});
