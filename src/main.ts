import dashboard from "../web/index.html";
import { CoinalyzeClient } from "./coinalyze/client.ts";
import { RateLimiter } from "./coinalyze/rate-limiter.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { Backfill } from "./funding/backfill.ts";
import { FundingSource } from "./funding/source.ts";
import { computeHealth } from "./health.ts";
import { createLogger, errorMessage } from "./log.ts";
import { runSourceLoop } from "./loop.ts";
import { HISTORY_LIMIT } from "./protocol.ts";
import { createServer } from "./server.ts";
import { SnapshotStore } from "./store.ts";
import type { Snapshot, SourceStatus } from "./types.ts";

const log = createLogger("main");

let config: Config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

let store: SnapshotStore;
try {
  store = new SnapshotStore({
    file: config.dataFile,
    historyFile: config.historyFile,
    historyLimit: HISTORY_LIMIT,
    historyRetentionMs: config.historyRetentionDays === undefined ? undefined : config.historyRetentionDays * 86_400_000,
  });
} catch (e) {
  log.error(`cannot open HISTORY_FILE ${config.historyFile}: ${errorMessage(e)}`);
  process.exit(1);
}
// One client and limiter for polls and backfills, so together they stay within the API budget.
const client = new CoinalyzeClient({ apiKey: config.coinalyzeApiKey, baseUrl: config.coinalyzeBaseUrl, limiter: new RateLimiter() });
const source = new FundingSource({ client, coins: config.coins, intervalMs: config.intervalMs });
const backfill = new Backfill({ client, store, intervalMs: config.intervalMs });

await store.load();
source.seedOpenInterest(store.latest());
const status: SourceStatus = { intervalMs: source.intervalMs, lastSuccessAt: null, consecutiveFailures: 0, lastError: null };
const startedAt = Date.now();
const server = createServer({
  port: config.port,
  authToken: config.authToken,
  authTimeoutMs: config.authTimeoutMs,
  pingIntervalMs: config.pingIntervalMs,
  pongTimeoutMs: config.pongTimeoutMs,
  development: config.development,
  store,
  getHealth: () => computeHealth(status, Date.now(), startedAt),
  meta: { coins: config.coins, intervalMs: config.intervalMs },
  dashboard,
});
log.info(`listening on http://localhost:${server.port} (coins: ${config.coins.join(",")}; every ${config.intervalMs / 1000}s)`);

const controller = new AbortController();
// Backfill.fill never throws, so a failed backfill never fails the poll cycle.
const persist = {
  add: async (snaps: Snapshot[]) => {
    await store.add(snaps);
    await backfill.fill(snaps);
  },
};
const loop = runSourceLoop(source, persist, status, controller.signal);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  controller.abort();
  // A poll may be waiting on the rate limiter or a Retry-After; don't wait for it longer than 5s.
  await Promise.race([loop, Bun.sleep(5000)]);
  server.stop();
  log.info("shutdown complete");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
