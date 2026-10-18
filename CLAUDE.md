# Project: predicted-funding-aggregator

## What this project is

A Bun + TypeScript service that publishes the **aggregated predicted funding rate** (BTC, ETH, SOL; % per 8h) over an authenticated WebSocket, with a live dashboard and `/health`.

- **Data:** only the official Coinalyze REST API. The API has no aggregated endpoint, so `FundingSource` aggregates the ten venues coinalyze.net lists on each coin's funding page. It computes a simple AVG and an OI-weighted average, both normalized to 8h, and publishes a per-venue breakdown.
- **The chart is not in the runtime.** `scripts/calibrate/` is an offline dev tool. It reads the coinalyze.net chart and per-venue table with headless Chromium to verify the venue list and 8h factors, and to measure how the API aggregate tracks the chart.

Primary consumers are internal services that need a stable, explainable funding-rate signal.

## Architecture at a glance

```
FundingSource ─(INTERVAL_MS)→ runSourceLoop → SnapshotStore ─┬→ funding_rate.json (latest per coin, DATA_FILE)
                                   │                         ├→ WS channel "funding-rate" → dashboard / clients
                                   │                         └→ history (HISTORY_LIMIT points per coin, in memory + HISTORY_FILE SQLite)
                                   └→ SourceStatus → GET /health
```

Runtime modes:

- **`bun run start`**: the service. Serves the dashboard (`GET /`), `/health` and `/ws`.
- **`bun run calibrate`**: the offline calibration tool. Needs `bunx playwright install chromium`; dev dependencies only.

## Module map

| File | Purpose |
|---|---|
| `src/main.ts` | Entry: config → store → source → loop → server; seeds OI from the store after `load()`; SIGINT/SIGTERM shutdown. **Only owner of `process.exit`** in the service and of the static `web/index.html` import. |
| `src/config.ts` | `loadConfig(env)` → `Config`; throws `ConfigError`. |
| `src/coins.ts` | `COIN_REGISTRY` (symbol → Coinalyze slug), `chartUrl`. |
| `src/types.ts` | `Snapshot` (wire = store = file format), `MarketComponent`, `HistoryPoint`, `Source`, `SourceStatus`. |
| `src/protocol.ts` | WS `ClientMessage`/`ServerMessage`, `CLOSE` codes, `CHANNEL`, `HISTORY_LIMIT`. Shared by `server.ts` and `web/app.ts`. |
| `src/log.ts` | `createLogger(scope)`: writes to **stderr only** (stdout is reserved for the calibration report). |
| `src/store.ts` | `SnapshotStore`: latest per coin (persisted to `DATA_FILE`), history of `HistoryPoint`s (persisted to `HISTORY_FILE` via `bun:sqlite`, one transaction per `add`, pruned to `historyLimit` per coin; `load()` seeds history from the DB only, never from the JSON), subscribers. The constructor opens the DB and throws on a bad file; `main.ts` exits 1. |
| `src/loop.ts` | `runSourceLoop`: drift-free (start-to-start), first poll immediate, never throws/exits; `abortableSleep`. |
| `src/health.ts` | `computeHealth` (pure): ok if a poll succeeded within 3 intervals (or startup grace), else 503. |
| `src/server.ts` | `createServer`: `Bun.serve` routes + WS protocol. |
| `src/coinalyze/client.ts` | `CoinalyzeClient`: `api_key` header, ≤20 symbols per request, every attempt goes through the limiter, 429 `Retry-After` (3 attempts, each wait logged as WARN, the rejected call refunded to the limiter), 401 fails immediately; includes 1-minute history for calibration. |
| `src/coinalyze/rate-limiter.ts` | Sliding window like the server's: 40 calls per 60 s, each call held 60 s + 250 ms margin; `acquire()` returns a refund for rejected requests. |
| `src/funding/universe.ts` | **`VENUES`**: the ten venues (page label, exchange code, quote, `ratePeriodHours`). The single source of methodology truth, together with `STALE_AFTER_MS`. |
| `src/funding/aggregate.ts` | `aggregate()` (pure AVG + OI-weighted). |
| `src/funding/source.ts` | `FundingSource`: resolves venues against `/future-markets` (24h cache), rolling per-market OI refresh (oldest first, refetched once ≥ `OI_REFRESH_MS` old, spare budget per cycle), OI seeded from persisted snapshots, OI-weighted null until every used venue has OI, an OI failure does not block AVG, staleness filter, components, budget warning. Clock injectable. |
| `scripts/calibrate/*` | `main.ts` (CLI), `analyze.ts` (pure: venue ratios, lag-aligned MAD, history SMA), `chart-page.ts`, `browser.ts`, `parse.ts`. |
| `web/index.html`, `web/app.ts`, `web/style.css` | Dashboard: token field with Show/Hide toggle, cards, AVG/OI-weighted chart (local time), per-venue table (one card per venue below 960 px, labelled from the `<th>` text via `data-label`, so header text and `td:nth-child` placement in `style.css` must stay in column order). Bun HTML import, `lightweight-charts` v5. |
| `test/*.test.ts` | `bun:test`; no network, no browser. |
| `Dockerfile`, `docker-compose.yml` | Pinned `oven/bun:1.4.3-debian`, production deps only (~240 MB), non-root, healthcheck; compose adds the `data` volume and `init`. |
| `.github/workflows/ci.yml` | `bun install --frozen-lockfile` → `bun run typecheck` → `bun test`. |

## Configuration (env vars)

Bun auto-loads `.env`. Do NOT use `dotenv`. All parsing happens in `src/config.ts`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `AUTH_TOKEN` | none | Required. There is no default token. |
| `COINALYZE_API_KEY` | none | Always required |
| `COINS` | `BTC,ETH,SOL` | Must be keys of `COIN_REGISTRY` |
| `INTERVAL_MS` | `60000` | 3 coins × 10 venues at 60 s ≈ 33 of 40 calls/min |
| `DATA_FILE` | `./funding_rate.json` | Compose sets `/app/data/funding_rate.json` on a named volume |
| `HISTORY_FILE` | `./history.sqlite` | Chart history DB; compose sets `/app/data/history.sqlite` on the same volume |
| `PING_INTERVAL_MS` | `30000` | |
| `PONG_TIMEOUT_MS` | `65000` | |
| `AUTH_TIMEOUT_MS` | `10000` | |

## WebSocket contract

- Endpoint `ws://<host>:<PORT>/ws`. Types live in `src/protocol.ts`; change them there and both ends follow.
- The client sends `{"type":"auth","token"}` within `AUTH_TIMEOUT_MS`. The server replies `{"type":"auth","status":"ok",coins,interval_ms}` and then `{"type":"history",points,latest}`.
- After that, each `Snapshot` (with `components`) is published on the `"funding-rate"` channel. Consumers filter by `symbol`.
- Keepalive: server `{"type":"ping"}` → client `{"type":"pong"}`.
- Close codes: `4001` invalid token, `4002` pong timeout, `4003` auth timeout.
- `Snapshot` keeps the v1 fields `aggregated_predicted_funding_rate`, `coin` (slug) and `timestamp`. Changing those names breaks v1 consumers.

## Non-obvious gotchas (read before changing methodology or the calibration tool)

1. **`VENUES` mirrors the site, not the API.**
   - The API lists many more stablecoin perpetuals: Polymarket contracts, ETHBTC/ETHU/USD1 quotes, Lighter, dYdX, and a Coinbase feed that returned a 12-day-old value. Do not widen the venue list to "all STABLE perps".
   - `bun run calibrate` reports listing drift when the page changes.
2. **Rate periods are measured.** Hyperliquid (`H`) and Kraken (`K`) report hourly rates (page ÷ API ≈ 8). Deribit, Huobi and OKX have no predicted rate in the API: they are omitted from the response rather than returned as `null`, and show as `no_rate`. Re-run the calibration if Coinalyze changes units.
3. **API budget: 40 calls/min per key, 1 call per symbol, counted over a sliding 60 s window.** Do not run the calibration tool and the service with the same key at the same time; together they exceed the budget and both get 429s. Two consecutive 30+-call cycles never fit in one window, so each cycle's first request waits for the previous cycle's first request to leave it: polls settle at about `INTERVAL_MS` + 250 ms, and that wait is by design (a 429 is not). Cold start costs only predicted rates plus spare-budget OI, so the first publish arrives in seconds; OI-weighted stays null for ~3–4 cycles unless seeded from `DATA_FILE`.
4. **API keys activate 2 minutes after generation**, and generating a new key deactivates the old one immediately. A fresh key returning 401 is expected for those 2 minutes.
5. **Loops never exit.** `runSourceLoop` catches everything and retries next cycle. Never add `process.exit` outside `main.ts` startup/shutdown.
6. **Calibration tool (`scripts/calibrate/`):**
   - **Stealth plugin is load-bearing.** Headless Chromium is challenged by Cloudflare unless `puppeteer-extra-plugin-stealth` is active (`browser.ts`). Don't "simplify" the `playwright-extra` wrapper.
   - **Blob iframe.** TradingView renders into a `blob:https://coinalyze.net…` iframe; enumerate `page.frames()` and filter with `isChartFrame`.
   - **Interval dropdown.** `#header-toolbar-intervals button` is labelled with the current interval; pick `[data-value="1"]`. The legend value depends on the interval (1h ≠ 1m), so re-select after every reload.
   - **Unicode minus.** Legend and table values use U+2212; `parseLegendValue`/`parsePercent` normalize it.
   - **Page table.** The per-venue boxes are `table.funding-rates div.box`. Coin-margined boxes carry `.coin-m`, the header box `.fr-type`, and labels are uppercased by CSS.
   - **Playwright must not own signals.** `BrowserManager` launches with `handleSIGINT/SIGTERM/SIGHUP: false`; Playwright's defaults close the browser and `exit(130)` on SIGINT.

## Project evolution (for orientation, not documentation)

v1 (single `scraper.js`, chart scraping; tagged `v1.0.0` on `ae5a441`), oldest-first: `942fd72` initial Playwright scraper → `f47200c` single file → `52a56c0` 1-minute buttons → `858c5f3` headless + stealth → `c6da13b` `--loop` → `19f02fe` WebSocket + Docker.

v2 (PR #12, squash-merged into `master` as `3b9e717` and tagged `v2.0.0`). The hashes below come from the PR branch, not `master`; fetch them with `git fetch origin pull/12/head`.
- **First pass (hybrid):** API source + live chart source, both runtime (`f23e4cd` … `c713af9`).
- **Second pass (API-only, `271a953`):**
  - The chart moved to the offline calibration tool.
  - The ten-venue list and the staleness filter were added.
  - Per-venue components went into snapshots and the dashboard.
  - Shared protocol types and a mode-specific config were introduced.
  - The Docker image shrank from 1.32 GB to ~240 MB.
- **Calibration and smoke pass:** measured venue ratios and chart tracking in the README (`5ede760`); README examples and the dashboard screenshot come from real smoke runs.

v2.1 (PR #14, squash-merged as `06ccff3` and tagged `v2.1.0`): predicted rates first, rolling per-market OI refresh with a seed from `DATA_FILE`, OI-weighted `null` until every used venue has OI, a sliding-window rate limiter matching the server, and 429 waits logged as WARN. Cold-start first publish dropped from 60–115 s to under 1 s, and the hidden 429 every cycle is gone.

Renamed from `coinalyze-api` to `predicted-funding-aggregator` after v2.1, because the old name read like an official Coinalyze client.

v2.2 (PR #17, squash-merged as `cc8832e` and tagged `v2.2.0`): the dashboard history is persisted to `HISTORY_FILE` (`bun:sqlite`, one transaction per cycle, pruned to `HISTORY_LIMIT` per coin), so the chart survives restarts and container re-creation. `load()` seeds history from the DB only and `funding_rate.json` only seeds latest, so points are not duplicated. A bad `HISTORY_FILE` exits 1 before any API call. Upgrading from v2.1 starts with empty history; there is no migration from `funding_rate.json`.

Headed mode, a separate server file, the live chart source, the `--once` mode (`bun run once`, removed after v2.2), `SOURCES`/`API_INTERVAL_MS`/`CHART_INTERVAL_MS` and "all STABLE perps" scope are historical.

## Working conventions for this repo

- **Modular TypeScript under `src/`.** One responsibility per module (see the module map). Keep pure logic (`aggregate`, `parse`, `health`, `config`) free of I/O so it stays unit-testable.
- **Explicit `.ts` import extensions** (`allowImportingTsExtensions`, `verbatimModuleSyntax`). Use `import type` for type-only imports.
- **Checks:** `bun test` and `bun run typecheck` must pass; CI runs both. Tests must not touch the network or launch a browser; inject fakes (`fetch`, `sleep`, `now`, `launch`).
- **When behavior changes, update `README.md` in the same commit.** The v1 README drifted badly.
- **Bun only.** Use `bun install`, `bun run`, `bun test` and `bunx`, never npm, node or npx. Prefer `Bun.*` APIs and built-ins (`Bun.serve`, `Bun.file`/`Bun.write`, `bun:sqlite`, global `WebSocket`) over `node:*` modules and npm packages such as `express`, `ws` or `better-sqlite3`. The dashboard is a Bun HTML import; there is no Vite or bundler config.
- **Style:** 2-space indent, double quotes, semicolons, arrow functions for top-level helpers. No linter/formatter enforced.
- **Commits and branches follow Conventional Commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `build:`, `perf:`; branches like `feat/<topic>`).
- **PRs are squash-merged into `master`**, one commit per PR titled with the PR title. Release tags go on the squash commit. Reference PR numbers or squash commits in "Project evolution", because branch hashes do not reach `master`. After a merge, pull `master` and delete the merged local branch with `git branch -D` (`-d` refuses squash-merged branches); check first that its content is on `master`.
