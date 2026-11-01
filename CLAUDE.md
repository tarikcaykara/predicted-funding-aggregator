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
| `src/store.ts` | `SnapshotStore`: latest per coin (persisted to `DATA_FILE`), history of `HistoryPoint`s (persisted to `HISTORY_FILE` via `bun:sqlite`, one transaction per `add`, pruned to `historyLimit` per coin; `load()` seeds history from the DB only, never from the JSON), subscribers. `load()` validates every component; `add` notifies subscribers before writing SQLite and `DATA_FILE` (temp file + rename), so a persistence error fails the cycle without starving WS clients. The constructor opens the DB and throws on a bad file; `main.ts` exits 1. |
| `src/loop.ts` | `runSourceLoop`: drift-free (start-to-start), first poll immediate, never throws/exits; `abortableSleep`. |
| `src/health.ts` | `computeHealth` (pure): ok if a poll succeeded within 3 intervals (or startup grace), else 503. |
| `src/server.ts` | `createServer`: `Bun.serve` routes + WS protocol; client messages capped at 16 KiB; dev server only when `development` (from `NODE_ENV=development`). |
| `src/coinalyze/client.ts` | `CoinalyzeClient`: `api_key` header, ≤20 symbols per request, every attempt goes through the limiter, 429 `Retry-After` (3 attempts, each wait logged as WARN, the rejected call refunded to the limiter), 401 fails immediately; includes 1-minute history for calibration. |
| `src/coinalyze/rate-limiter.ts` | Sliding window like the server's: 40 calls per 60 s, each call held 60 s + 250 ms margin; `acquire()` returns a refund for rejected requests. |
| `src/funding/universe.ts` | **`VENUES`**: the ten venues (page label, exchange code, quote, `ratePeriodHours`). The single source of methodology truth, together with `STALE_AFTER_MS` (defined in `source.ts`). |
| `src/funding/aggregate.ts` | `aggregate()` (pure AVG + OI-weighted). |
| `src/funding/source.ts` | `FundingSource`: resolves venues against `/future-markets` (24h cache), rolling per-market OI refresh (oldest first, refetched once ≥ `OI_REFRESH_MS` old, spare budget per cycle), OI seeded from persisted snapshots, OI-weighted null until every used venue has OI, an OI failure does not block AVG, staleness filter, components, budget warning. Clock injectable. |
| `scripts/calibrate/*` | `main.ts` (CLI), `analyze.ts` (pure: venue ratios, lag-aligned MAD, history SMA), `chart-page.ts`, `browser.ts`, `parse.ts`. |
| `web/index.html`, `web/app.ts`, `web/style.css`, `web/fonts/` | Dashboard, "Number Line" design: sidebar with token field (Show/Hide toggle; no `name`, so a native submit cannot put the token in a URL), coin buttons carrying each coin's OI-weighted value (a tablist: arrows/Home/End, selection follows focus), data age; headline metrics (AVG, OI-weighted, spread, venues used + pips); AVG/OI-weighted lines over a spread histogram pane (local time, with the local date at UTC day boundaries, a whitespace gap where consecutive points are more than 3 intervals apart, colours read from the `--chart-*` tokens; a live point that evicts the oldest redraws the series without resetting the zoom, so it stays at `HISTORY_LIMIT` points); venue rows cloned from `#venue-row` as dots on a shared rate axis (dot area ∝ OI weight, AVG/OI markers, sorted by 8h rate, excluded hatched; cards below 1100 px). CSS keys every state on `#app[data-conn]` (`disconnected`/`connecting`/`connected`/`rejected`) and `#app[data-data]` (`waiting-data`/`waiting-oi`/`live`/`stale`; stale beats waiting-oi); the `#data-announce` live region speaks each data-state change of the selected coin; the connecting pulse stops under `prefers-reduced-motion`. `.v[data-status]` carries the wire value `unlisted`, not the export fixture's `not_listed`. `index.html` = the export's markup minus Google Fonts and the token's `name`, plus `./style.css`, `./app.ts`, the `#history-window` span and `#data-announce`. `style.css` = JetBrains Mono + Space Grotesk `@font-face` rules + a `[hidden]` rule (`hidden` must beat `.coin { display: flex }`) + the export's `styles.css` minus its states-board section, plus the reduced-motion rule. Reference renderer: `design/handoff/number-line/app.js`. Bun HTML import (inlines the fonts as `data:` URIs), `lightweight-charts` v5. The previous "Ledger" dashboard is archived at tag `v3.1.0` (restore command in the README). |
| `design/handoff/` | Claude Design reference exports, each with `screens/`, not imported by `web/` and excluded from the Docker image. `number-line/` (current): `index.html?state=…` and `states.html` render every state offline from `data.js`; `app.js` is the reference renderer. `ledger/` (v3.1, archived): DOM contract in `ledger/README.md`. |
| `test/*.test.ts` | `bun:test`; no external network, no browser. `e2e.test.ts` spawns `src/main.ts` against `fake-coinalyze.ts` (cold start, restart, startup errors); `ws-client.ts` is the shared WS test client. |
| `Dockerfile`, `docker-compose.yml` | Pinned `oven/bun:1.4.3-debian`, production deps only (~240 MB), code root-owned, only `/app/data` writable by the non-root `bun` user, sets `DATA_FILE`/`HISTORY_FILE` under `/app/data`, healthcheck; compose adds the `data` volume and `init`, and repeats the data paths because `env_file` beats image `ENV` and a copied `.env.example` sets `./` paths. |
| `.github/workflows/ci.yml` | `bun install --frozen-lockfile` → `bun run typecheck` → `bun test`; `contents: read` token, no persisted credentials, actions pinned to commit SHAs. |
| `.github/dependabot.yml` | Weekly Dependabot version updates for `bun` and `github-actions`; policy in "Dependencies" below. |

## Configuration (env vars)

Bun auto-loads `.env`. Do NOT use `dotenv`. All parsing happens in `src/config.ts`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | 1–65535 |
| `AUTH_TOKEN` | none | Required. At least 32 characters. There is no default token, and `.env.example` leaves it empty on purpose: a copied file stops at startup until a token is set. |
| `COINALYZE_API_KEY` | none | Always required |
| `COINALYZE_BASE_URL` | `https://api.coinalyze.net/v1` | Coinalyze API base URL. For the e2e test's fake server or a proxy; http(s) only |
| `COINS` | `BTC,ETH,SOL` | Must be keys of `COIN_REGISTRY` |
| `INTERVAL_MS` | `60000` | 3 coins × 10 venues at 60 s ≈ 33 of 40 calls/min |
| `DATA_FILE` | `./funding_rate.json` | The Docker image and compose set `/app/data/funding_rate.json` (compose mounts the `data` volume there) |
| `HISTORY_FILE` | `./history.sqlite` | Chart history DB. The Docker image and compose set `/app/data/history.sqlite` (same volume) |
| `PING_INTERVAL_MS` | `30000` | |
| `PONG_TIMEOUT_MS` | `65000` | Must be greater than `PING_INTERVAL_MS` |
| `AUTH_TIMEOUT_MS` | `10000` | |
| `NODE_ENV` | unset | `development` serves the dashboard through Bun's dev server (HMR, error overlay); any other value serves the production bundle. The Docker image sets `production` |

## WebSocket contract

- Endpoint `ws://<host>:<PORT>/ws`. Types live in `src/protocol.ts`; change them there and both ends follow.
- The client sends `{"type":"auth","token"}` within `AUTH_TIMEOUT_MS`. The server replies `{"type":"auth","status":"ok",coins,interval_ms}` and then `{"type":"history",points,latest}`.
- After that, each `Snapshot` (with `components`) is published on the `"funding-rate"` channel. Consumers filter by `symbol`.
- Keepalive: server `{"type":"ping"}` → client `{"type":"pong"}`.
- Close codes: `4001` invalid token, `4002` pong timeout, `4003` auth timeout. A client message over 16 KiB closes the connection unparsed: Bun sends 1009 on macOS but drops the socket without a close frame on Linux, where clients see 1006.
- `Snapshot` keeps the v1 fields `aggregated_predicted_funding_rate`, `coin` (slug) and `timestamp`. Changing those names breaks v1 consumers.

## Non-obvious gotchas (read before changing methodology or the calibration tool)

1. **`VENUES` mirrors the site, not the API.**
   - The API lists many more stablecoin perpetuals: Polymarket contracts, ETHBTC/ETHU/USD1 quotes, Lighter, dYdX, and a Coinbase feed that returned a 12-day-old value. Do not widen the venue list to "all STABLE perps".
   - `bun run calibrate` reports listing drift when the page changes, and `unknown` when no sample could read the venue table.
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

v3.0 (tagged `v3.0.0` on `a8b21e8`, the #20 squash commit):
- **PR #19 (`8497d91`):** the dashboard got the token Show/Hide toggle and a responsive layout (one card per venue below 960 px).
- **PR #20 (`a8b21e8`):** removed the `--once` mode (`bun run once`). `loadConfig` returns a single `Config` and `AUTH_TOKEN` is always required. Breaking: read `DATA_FILE` or the WebSocket from `bun run start` instead.

v3.1 (PR #22, squash-merged as `9b980be` and tagged `v3.1.0`): the dashboard implements the Claude Design "Ledger" direction. `web/` takes the export's markup and stylesheet verbatim plus self-hosted IBM Plex fonts. `app.ts` keeps the WebSocket and chart logic, renders through the export's DOM contract (`data-*`/ARIA attributes), marks Per 8h values more than 1σ from AVG and draws step lines coloured from the CSS tokens. The unedited export and its reference screens are committed in `design/handoff/` and kept out of the Docker image.

v3.2 (PR #24, squash-merged as `282841f` and tagged `v3.2.0`): the dashboard implements the Claude Design "Number Line" direction. `web/` takes the export's markup (Google Fonts links dropped, local stylesheet and script, a `#history-window` span) and its stylesheet minus the states board, plus self-hosted JetBrains Mono and Space Grotesk. `app.ts` keeps the WebSocket, history and reconnect logic and renders the `#app[data-conn]`/`[data-data]` states, venues as dots on a shared rate axis (area ∝ OI weight) and a spread histogram pane. The default coin is BTC. Ledger is archived at `v3.1.0` (restore command in the README); both exports live in `design/handoff/number-line/` and `design/handoff/ledger/`.

v3.2.1 (PR #26, tagged `v3.2.1`): the dashboard chart's time axis shows the date where the day changes (the crosshair label too), and a pause longer than three poll intervals leaves a gap instead of a joined line, as the README already described. The README screenshot was retaken from a continuous run.

v3.2.2 (PRs #27 and #28, tagged `v3.2.2`): `.env.example` leaves `AUTH_TOKEN` empty, so a copied file stops at startup instead of running with the known `change-me` token. The calibration report prints `Listing: unknown` when no sample read the venue table, where it used to claim an exact match. #28 updated `@types/bun` and Playwright and moved `brace-expansion` to 1.1.21, which clears the high advisories in the stealth plugin's dev-only dependency tree.

v4.0 (tagged `v4.0.0` on `240afa1`, the #31 squash commit):
- **PR #29 (`90a1810`):** fixes from an end-to-end audit of v3.2.2.
  - Config: `AUTH_TOKEN` ≥ 32 characters, numeric bounds, `PONG_TIMEOUT_MS` > `PING_INTERVAL_MS`, `COINALYZE_BASE_URL`, and Bun's dev server only with `NODE_ENV=development`.
  - Server: client messages capped at 16 KiB.
  - Store: components validated on load, subscribers notified before persisting, atomic `DATA_FILE`.
  - Funding: future-dated OI seeds ignored.
  - Dashboard: bounded live chart, keyboard coin tabs, data-state announcements, reduced motion, token input without `name`.
  - Image and CI: root-owned code with only `/app/data` writable; CI with `contents: read` and no persisted credentials.
  - Tests: `test/e2e.test.ts` (process-level, against `test/fake-coinalyze.ts`) and the test-first rule.
  - Breaking: those config checks stop startup with exit 1, and a bare-metal `bun run start` serves the production bundle.
  - The PR lists the findings deliberately left unfixed, and the compose `environment:` block kept against the plan.
- **PR #30 (`720b58a`):** Dependabot version updates (`bun`, `github-actions`; weekly, 7-day cooldown), actions pinned to commit SHAs, Dependabot alerts and security updates enabled. GitHub's dependency graph does not read `bun.lock`, so `bun audit` stays the transitive check. Dependabot's first run started about 13 minutes after the merge.
- **PR #31 (`240afa1`):** Dependabot's first PR, `actions/checkout` 4.4.0 → 7.0.1.

Headed mode, a separate server file, the live chart source, the `--once` mode (`bun run once`, removed in v3.0), `SOURCES`/`API_INTERVAL_MS`/`CHART_INTERVAL_MS` and "all STABLE perps" scope are historical.

## Working conventions for this repo

- **Modular TypeScript under `src/`.** One responsibility per module (see the module map). Keep pure logic (`aggregate`, `parse`, `health`, `config`) free of I/O so it stays unit-testable.
- **Explicit `.ts` import extensions** (`allowImportingTsExtensions`, `verbatimModuleSyntax`). Use `import type` for type-only imports.
- **Checks:** `bun test` and `bun run typecheck` must pass; CI runs both. Tests must not reach the external network or launch a browser; loopback servers on port 0 and child processes of `src/main.ts` are fine. Inject fakes (`fetch`, `sleep`, `now`, `launch`) or point `COINALYZE_BASE_URL` at `test/fake-coinalyze.ts`.
- **Test-first, at the lowest layer that proves the behaviour.** For a bug, first add a test that fails on the current code and run it red, then fix. For a feature, write the test of the new behaviour before the code. Pure logic gets a unit test; protocol, persistence and client behaviour get an integration test in the existing suites (`server.test.ts`, `store.test.ts`, `client.test.ts`); `test/e2e.test.ts` changes only when startup, the WS contract, persistence across restarts or the dashboard route change. Behaviour that exists only in the dashboard's DOM or canvas has no test suite: check it in a browser against the service and `test/fake-coinalyze.ts`, and describe the check in the PR.
- **When behavior changes, update `README.md` in the same commit.** The v1 README drifted badly.
- **Bun only.** Use `bun install`, `bun run`, `bun test` and `bunx`, never npm, node or npx. Prefer `Bun.*` APIs and built-ins (`Bun.serve`, `Bun.file`/`Bun.write`, `bun:sqlite`, global `WebSocket`) over `node:*` modules and npm packages such as `express`, `ws` or `better-sqlite3`. The dashboard is a Bun HTML import; there is no Vite or bundler config.
- **Style:** 2-space indent, double quotes, semicolons, arrow functions for top-level helpers. No linter/formatter enforced.
- **Commits and branches follow Conventional Commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `build:`, `ci:`, `perf:`; branches like `feat/<topic>`).
- **PRs are squash-merged into `master`**, one commit per PR titled with the PR title. Release tags go on the squash commit. Reference PR numbers or squash commits in "Project evolution", because branch hashes do not reach `master`. After a merge, pull `master` and delete the merged local branch with `git branch -D` (`-d` refuses squash-merged branches); check first that its content is on `master`.

## Dependencies

- **Dependabot** (`.github/dependabot.yml`) opens update PRs weekly, each release only after a 7-day cooldown; security updates do not wait.
  - Bun packages come as `build(deps)` / `build(deps-dev)`. Minor and patch updates of the dev tooling are grouped as `dev-tooling`. `lightweight-charts` (the only runtime package) and every major update come alone.
  - GitHub Actions come as `ci(deps)`. Actions are pinned to a commit SHA with a `# vX.Y.Z` comment, which Dependabot updates together; pin any new action the same way.
- **Reviewing a Dependabot PR.** CI must pass as for any PR (typecheck and every test, e2e included). For a major update, read the changelog first.
  - `lightweight-charts`: CI only proves the bundle builds. Check the dashboard chart in a browser against `test/fake-coinalyze.ts`, as the test-first rule says, and note the check in the PR.
  - `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`: dev-only. Run `bunx playwright install chromium` before the next `bun run calibrate`.
- **The Bun runtime is not updated by Dependabot** (`@types/bun` is ignored, the `docker` ecosystem is not configured): the image, CI and the type definitions must move together. Bump them by hand in one PR:
  - `Dockerfile`: `FROM oven/bun:<version>-debian`;
  - `.github/workflows/ci.yml`: `bun-version`;
  - `package.json`: `@types/bun`, then `bun install` to update `bun.lock`;
  - the image version in README "Docker / Compose" and in the `Dockerfile` row of the module map (the README badge shows only the minor).
- **Alerts.** Dependabot alerts and security updates are enabled in the repository settings. GitHub's dependency graph does not read `bun.lock`: it sees only `package.json` (direct dependencies, by declared range) and the actions in `ci.yml`, so alerts and security updates never cover transitive packages. `bun audit` is the check for those. It currently reports `deepmerge` (low) and `minimatch` (moderate): both dev-only, reached through `puppeteer-extra-plugin-stealth`, absent from the image, with no patched version in range; re-check them whenever the stealth plugin changes.
