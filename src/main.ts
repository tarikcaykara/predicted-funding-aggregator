import dashboard from "../web/index.html";
import { CoinalyzeClient } from "./coinalyze/client.ts";
import { RateLimiter } from "./coinalyze/rate-limiter.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { FundingSource } from "./funding/source.ts";
import { computeHealth } from "./health.ts";
import { createLogger, errorMessage } from "./log.ts";
import { runSourceLoop } from "./loop.ts";
import { HISTORY_LIMIT } from "./protocol.ts";
import { createServer } from "./server.ts";
import { SnapshotStore } from "./store.ts";
import type { SourceStatus } from "./types.ts";

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
  store = new SnapshotStore({ file: config.dataFile, historyFile: config.historyFile, historyLimit: HISTORY_LIMIT });
} catch (e) {
  log.error(`cannot open HISTORY_FILE ${config.historyFile}: ${errorMessage(e)}`);
  process.exit(1);
}
const source = new FundingSource({
  client: new CoinalyzeClient({ apiKey: config.coinalyzeApiKey, baseUrl: config.coinalyzeBaseUrl, limiter: new RateLimiter() }),
  coins: config.coins,
  intervalMs: config.intervalMs,
});

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
const loop = runSourceLoop(source, store, status, controller.signal);

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
