# Predicted Funding Aggregator: dashboard handoff ("Receipt")

This folder is the reference implementation of the chosen dashboard direction. Production is vanilla TypeScript on **the same markup**. It copies the DOM writes in `app.js`, which this document lists as the DOM contract.

| File | What it is |
|---|---|
| `index.html` | The dashboard markup, including the fixed hooks and two `<template>`s for venue rows. |
| `styles.css` | Every design token in one `:root` block (one dark theme). Component rules use only tokens. The state-board section is last. |
| `app.js` | The reference renderer. Each `render*()` function owns one region of the page. |
| `data.js` | Fixtures built from the attached real data: snapshots plus 12 h histories. |
| `states.html` | Every state as an iframe of `index.html` at 1440, 768 and 390 px. |
| `vendor/lightweight-charts.standalone.production.js` | lightweight-charts v5.2.1, unchanged. |

Open `index.html` or `states.html` straight from disk, or serve the folder (for example `python3 -m http.server`). Fonts come from the Google Fonts `<link>`s. Production self-hosts IBM Plex Sans and IBM Plex Mono, both under the SIL OFL.

## Query parameters

| Parameter | Values | Effect |
|---|---|---|
| `state` | `disconnected` · `connecting` · `rejected` · `waiting-data` · `waiting-oi` · `live` · `stale` | Renders that state from fixtures, with a fixed clock and no storage. |
| `coin` | `BTC` · `ETH` · `SOL` (default `BTC`) | Selected coin. |
| `token` | `hidden` · `visible` (default `hidden`) | Token field masked, or shown with **Hide** pressed. |
| `fixture` | comma list: `statuses`, `backfill` | `statuses`: WOO X `stale`, DERIBIT `unlisted`, aggregates recomputed. `backfill`: the points from 6 h to 4 h 30 min before the newest point carry `source: "backfill"`. |
| `pseudo` | comma list: `coin`, `buttons`, `rows` | **State board only.** Forces hover and focus looks with classes. Production ignores it. |

Without `?state` the page runs as a demo:
- A token stored in `localStorage["pfa.token"]` reconnects on load.
- **Connect** stores the token, then plays connecting → live. A token containing "bad" is rejected.
- The clock ticks, so the data goes stale after 3 minutes.

## State model

`#app` carries the two attributes every state style keys on:

| Attribute | Values | Rule |
|---|---|---|
| `data-conn` | `disconnected` · `connecting` · `connected` · `rejected` | The WebSocket and auth state. |
| `data-data` | `waiting-data` · `waiting-oi` · `live` · `stale` | Worked out for the **selected coin**, checked in this order: |

1. `waiting-data` if not connected or there is no snapshot yet.
2. `stale` if `now − snapshot.timestamp > 180 000 ms` (3 poll intervals of 60 s). Stale wins over waiting-oi.
3. `waiting-oi` if `oi_weighted_predicted_funding_rate === null` or `open_interest_usd === null`.
4. `live` otherwise.

The service sends `null` until every used venue has reported open interest (OI-weighted) and until every listed venue has (total). The renderer never infers that itself. It reads the nulls.

What CSS does from these two attributes, so production needn't toggle anything for it:

| State | CSS effect |
|---|---|
| `data-conn="connecting"` | Spinner in `#token-connect` (its label is written by `app.js`). |
| `data-conn="rejected"` | Nothing on its own: the field's error look comes from `aria-invalid` and `#token-help[data-tone="error"]` (see Token gate). |
| `data-data="waiting-data"` | `#venue-table` and the chart canvas hidden; `#venue-placeholder` and `#chart-status` shown. |
| `data-data="stale"` | `#stale-notice` shown; amber data-age tile; headline values greyed with a "stale" tag. |

## Data shapes

**Snapshot**: one per coin, as in `funding_rate.json`. Rates are in % per 8h and open interest in USD.

```js
{ timestamp, aggregated_predicted_funding_rate, oi_weighted_predicted_funding_rate, markets,
  open_interest_usd, unit: "percent_per_8h",
  components: [{ venue, symbol, predicted_rate, rate_period_hours, rate_8h, oi_usd, updated_at, status }] }
```

`status` is exactly one of `used`, `stale`, `no_rate` or `unlisted`. Only `used` venues enter AVG and OI-weighted. Every venue except `unlisted` counts toward `open_interest_usd`.

**History point**: `{ timestamp, aggregated_predicted_funding_rate, oi_weighted_predicted_funding_rate, markets, open_interest_usd, source? }`. A point with `source === "backfill"` was rebuilt from 1-minute history after a restart and is drawn muted. The attached files' own `source` field is dropped in `data.js`.

## DOM contract

`text` means `textContent`. All attribute values are strings. Every element below exists in `index.html` except venue rows and marks, which are cloned from templates.

### Root and shared bindings

| Element | Selector | Writes |
|---|---|---|
| Root | `#app` | `data-conn`, `data-data` (see State model). |
| Coin name (several places) | `[data-bind="coin"]` | text: `BTC` · `ETH` · `SOL`. |
| Used-venue count (formula, table head, Σ row) | `[data-bind="used-count"]` | text: number of `used` venues, e.g. `7`; `n` before the first snapshot. |
| Live region | `#data-announce` | text, written only when coin, `data-conn`, `data-data` or the empty-token error changes. It is visually hidden, with `aria-live="polite"` and `aria-atomic="true"`. |

`#data-announce` messages:

| When | Message |
|---|---|
| Empty token on Connect | `Enter a token to connect.` |
| Disconnected | `Disconnected.` |
| Connecting | `Connecting.` |
| Rejected | `Token rejected.` |
| Connected, waiting for data | `BTC: connected, waiting for data.` |
| Waiting for open interest | `BTC: AVG received, waiting for open interest.` |
| Stale | `BTC: data is stale, last update 3m 34s ago.` |
| Live | `BTC: live.` |

### Token gate

| Element | Selector | Writes |
|---|---|---|
| Form | `#token-form` | Listens for `submit` (and calls `preventDefault`). |
| Field | `#token-input` | `type`: `password` (hidden) or `text` (visible). `value`, set only when it differs from the model so typing isn't disturbed. `aria-invalid`: `true` when rejected or when the token is empty on Connect, else `false`. It has **no `name` attribute**, so browsers don't treat it as a credential form. Static: `autocomplete="off"`, `aria-describedby="token-help"`. |
| Show/Hide | `#token-toggle` | text: `Show` or `Hide`. `aria-pressed`: `false` or `true`. |
| Connect | `#token-connect` | `aria-disabled`: `true` while connecting (clicks are ignored), else `false`. |
| Connect label | `#token-connect-label` | text: `Connect` or `Connecting…`. |
| Help | `#token-help` | text (see below). `data-tone`: `error` or `neutral`. |

`#token-help` text:
- Empty on Connect: `Enter a token to connect.`
- Rejected: `Token rejected by the service. Check it and connect again.`
- Disconnected: `Paste the access token from your service config. It is remembered on this device.`
- Otherwise: `Remembered on this device, so a reload reconnects.`

Production stores the token on a successful submit and reconnects with it on load.

### Coin selector

| Element | Selector | Writes |
|---|---|---|
| Group | `#coin-group` (`role="radiogroup"`) | Listens for `click` and `keydown`. |
| Option | `#coin-group [role="radio"][data-coin="BTC"]` (also ETH, SOL) | `aria-checked`: `true` or `false`. `tabindex`: `0` on the selected option, `-1` on the others (roving tabindex). |
| Option rate | `[data-coin="…"] [data-coin-rate]` | text: that coin's OI-weighted rate (`+0.00798`); `pending` if its OI-weighted is null; `—` when not connected. |

Keyboard: ArrowRight and ArrowDown select the next coin, ArrowLeft and ArrowUp the previous one (both wrap), Home selects the first and End the last. Focus moves with the selection. Changing coin closes any open venue rows and re-renders.

### Data age and stale notice

| Element | Selector | Writes |
|---|---|---|
| Value | `#data-age-value` | `—` before a snapshot, else the age plus " ago": `4s ago`, `3m 34s ago`, `2h 05m ago`. Production recomputes it from `Date.now()` every second. |
| Note | `#data-age-note` | See below. |
| Notice text | `#stale-notice-text` | When stale: `No new snapshot for 3m 34s, more than 3 poll intervals. The values below are the last ones received, at 19:17:20.` Otherwise empty. The notice itself is shown by CSS. |

`#data-age-note` text:
- Before a snapshot: `Not connected` or `No snapshot yet`
- Live or waiting-oi: `Fresh · snapshot at 19:17:20` (local time)
- Stale: `Stale · older than 3 poll intervals (180 s)`

### Headline values

| Element | Selector | Writes |
|---|---|---|
| Section | `#kpis` | `aria-label`: `Headline values for BTC`. |
| AVG | `#kpi-avg` | text `+0.00910`, and `data-pending="false"`. |
| OI-weighted | `#kpi-oi` | text `+0.00798`, or `waiting for open interest…` with `data-pending="true"`. |
| Spread | `#kpi-spread` | text: OI-weighted − AVG in pp (`−0.00112`). Pending like OI-weighted. |
| Venues used | `#kpi-venues` | text `7 / 10` (`markets` / number of components). |
| Venue marks | `#kpi-venues-marks` | Children replaced: one `span.mark[data-status="used\|stale\|no_rate\|unlisted"]` per venue, in breakdown order. Used marks are filled. |
| Total OI | `#kpi-oi-total` | text `$17.53B`, or `waiting for open interest…` with `data-pending="true"`. |
| Total OI note | `#kpi-oi-total-note` | `USD · 10 listed venues`, counting venues whose status isn't `unlisted`. |

Before the first snapshot all five values read `waiting for data…`, or `not connected` when disconnected or rejected, each with `data-pending="true"`.

### History chart

| Element | Selector | Writes |
|---|---|---|
| Window label | `#history-window` | text `12h`. |
| Chart container | `#chart` | The chart library mounts here (`autoSize`). `aria-label`: a summary such as `12h history for BTC: AVG and OI-weighted lines, spread bars in the lower pane. Latest AVG +0.00910, OI-weighted +0.00798 % per 8h.`, with ` Includes rebuilt points.` appended when there are any. Before data it reads `History chart, waiting for data…`. |
| Empty-state text | `#chart-status` | `waiting for data…` or `not connected`. Shown by CSS only in `waiting-data`. |
| Backfill legend | `#legend-backfill` | `hidden` when the selected coin's history has no rebuilt points; removed otherwise. |
| Backfill caption | `#history-backfill-note` | `hidden` like the legend. text: `Muted points 13:18–14:47 were rebuilt from 1-minute history after a restart.` (local times, one range per run of rebuilt points). |
| Time zone | `#history-tz` | text: the IANA time zone, e.g. `Europe/Berlin`. |

Chart setup (`initChart`, `renderChart`):
- **Tokens.** It reads `--chart-*`, `--font-mono`, `--chart-font-size`, `--chart-line-width` and `--chart-spread-pane` with `getComputedStyle(document.documentElement)`. Colour tokens are literal `#rrggbb` because the library parses them itself.
- **Series.** Two `LineSeries` (AVG, OI-weighted) go in pane 0 and one `HistogramSeries` (spread = OI-weighted − AVG) in pane 1. Pane 1 height is `--chart-spread-pane`, set with `chart.panes()[1].setHeight()`. Price format is custom: signed with 5 decimals.
- **Per-point colour, the only per-point style.**
  - AVG: `--chart-avg`, or `--chart-avg-backfill` on rebuilt points.
  - OI-weighted: `--chart-oi`, or `--chart-oi-backfill` on rebuilt points.
  - Spread: `--chart-spread-pos` or `--chart-spread-neg` by sign, with the `-backfill` variants on rebuilt points.
  - A line segment takes its left point's colour, so a muted stretch ends one segment after its last rebuilt point.
- **Gaps.** When two points are more than 180 s apart, one whitespace point (`{ time }`) is inserted per missing minute, which breaks both lines and the bars. A null OI-weighted is also whitespace.
- **Axis.** Local `HH:MM` on the time axis. Where the UTC day changes, the library passes `tickMarkType ≤ 2`, and the formatter prints the UTC date (`20 Nov`) there.
- **Re-render.** The data is replaced only when coin, data state or fixture changes.

### Venue breakdown

| Element | Selector | Writes |
|---|---|---|
| Placeholder title | `#venue-placeholder-title` | `waiting for data…` or `not connected`. |
| Placeholder text | `#venue-placeholder-text` | `The breakdown appears with the first snapshot.` or `Connect with your access token to see how the ten venues produce AVG and OI-weighted.` |
| Used rows | `#venue-rows-used` | Children replaced: one row from `#tpl-venue-row` per `used` venue, by open interest, descending. |
| Excluded rows | `#venue-rows-excluded` | Children replaced: rows for `stale`, then `unlisted`, then `no_rate` venues, each group by open interest. |
| Σ used OI | `#sum-used-oi` | `$14.66B`, or `pending` while any used venue lacks `oi_usd`. |
| Σ weights | `#sum-weights` | `100%` or `pending`. |
| Σ AVG | `#sum-avg` | Same value as `#kpi-avg`. |
| Σ OI-weighted | `#sum-oi` | Same value as `#kpi-oi`, or `pending`. |
| Excluded count | `#venue-excluded-count` | text `3`. |
| Listed count | `#venue-listed-count` | text `10` (9 when one venue is `unlisted`). |
| Total OI | `#venue-total-oi` | Same value as `#kpi-oi-total`. |

**Venue row**, a clone of `#tpl-venue-row` (`.vrow.vrow-venue`):

| Element | Selector inside the row | Writes |
|---|---|---|
| Row | itself | `id`: `venue-<slug>`, e.g. `venue-binance-usdt`. `data-venue`: the venue name. `data-status`: `used` · `stale` · `no_rate` · `unlisted`. `data-open`: `true` or `false`. |
| Toggle | `.vtoggle` | `aria-expanded`: `true` or `false`. `aria-controls`: `venue-<slug>-detail`. |
| Venue | `[data-field="venue"]` | `BINANCE USDT` |
| Market | `[data-field="symbol"]` | `BTCUSDT_PERP.A` |
| Predicted | `[data-field="predicted"]` | `+0.00125`, or `—` when null. |
| Period | `[data-field="period"]` | `1h` or `8h`. |
| Rate / 8h | `[data-field="rate-8h"]` | `+0.01000`, or `—`. |
| Open interest | `[data-field="oi"]` | `$2.43B`. `waiting…` while it hasn't reported; `—` for `unlisted`. |
| OI weight | `[data-field="weight"]` | Share of used open interest (`16.6%`, `<0.1%`); `pending`; `—` when excluded. |
| Weight bar | `[data-field="weight-bar"]` | `style="--weight: 16.60%"`. Its parent `.wbar` gets `hidden` on excluded rows. |
| → AVG | `[data-field="to-avg"]` | `rate_8h ÷ n`, e.g. `+0.00143`; `—` when excluded. |
| → OI-weighted | `[data-field="to-oi"]` | `rate_8h × weight`, e.g. `+0.00166`; `pending`; `—`. |
| Status | `[data-field="status"]` | `Used` · `Excluded · stale 4m 16s` · `Excluded · not listed` · `Excluded · no predicted rate`. |
| Detail | `.vdetail` | `id`: `venue-<slug>-detail`. `hidden` unless open. Children: lines from `#tpl-venue-line`, each filling `.vline-k` and `.vline-v`. |

Detail lines by status:
- **used**
  - `Rate / 8h`: `+0.00125 per 1h × 8 = +0.01000`, or `+0.00707, already per 8h`
  - `→ AVG`: `+0.01000 ÷ 7 = +0.00143`
  - `→ OI-weighted`: `+0.01000 × 16.6% = +0.00166`
  - `OI weight`: `$2.43B of $14.66B used open interest`
- **stale**
  - `Why excluded`: `Last update 4m 16s ago, older than 3 poll intervals (180 s).`
  - `Last rate`: `+0.01000 per 8h, shown for reference only.`
  - `Open interest`: `$14.55M still counts toward total open interest.`
- **unlisted**
  - `Why excluded`: `This market is not listed on DERIBIT, so it has no rate and no open interest.`
- **no_rate**
  - `Why excluded`: `No predicted rate from this venue, so it is outside AVG and OI-weighted.`
  - `Open interest`: `$2.04B still counts toward total open interest.`

Opening and closing a row only flips `data-open`, `aria-expanded` and the detail's `hidden`; the table isn't re-rendered. When the table is re-rendered, focus goes back to the same venue's toggle.

## Formatting

| Value | Rule | Example |
|---|---|---|
| Rates and spread | Signed, 5 decimals, U+2212 minus sign. | `+0.01032`, `−0.00112`, `0.00000` |
| USD | 2 decimals, with a B or M suffix. | `$17.53B`, `$104.94M` |
| Shares | 1 decimal; below 0.1% shows as `<0.1%`. | `40.8%` |
| Durations | Under 60 s, then minutes and seconds, then hours and minutes. | `4s`, `3m 34s`, `2h 05m` |
| Clock | Local 24 h time. | `19:17:20` |

## Tokens (`styles.css`)

There is one token block, `:root`, and one theme (dark). It sets `color-scheme: dark`, so form controls and scrollbars match. It is grouped as:
- **Colour:** surfaces, text, lines, interactive and status.
- **Chart:** literal `#rrggbb` colours, plus `--chart-font-size`, `--chart-line-width`, `--chart-spread-pane` and the chart heights.
- **Type:** families, weights, leading, tracking, and the type scale twice: `--text-*-mobile` (base) and `--text-*-desktop` (≥ 901 px; headline figures ≥ 1181 px).
- **Spacing:** a 4 px grid.
- **Sizes:** including the 44 px touch target and `--size-gate-max`, the token form's width beside the brand.
- **Borders, radii, shadows, focus, motion and layers.**

Contrast, checked pair by pair (every text colour on every surface it sits on):
- **Text:** at least 4.97:1, so WCAG AA passes for all text.
- **Rebuilt points:** 1.8–2.3:1 against the chart background and 3.3–4.3:1 against their live colours, so they read as clearly muted but stay traceable.

The CSS is mobile first. Breakpoints are 561, 901 and 1181 px. The header holds the brand and the token form: stacked below 901 px, side by side from 901 px. The breakpoints they appear in a comment because media queries can't read custom properties. Under `prefers-reduced-motion: reduce` all animation and transitions stop.

## Accessibility notes

- Focus is visible everywhere: a 2 px `--color-focus` ring offset 2 px.
- Every control is reachable by keyboard: the token field, Show, Connect, the coin radios with roving tabindex, the venue toggles, and the Coinalyze link.
- The venue breakdown is an ARIA table (`role="table"`, rowgroups, rows, `columnheader`, `rowheader`, cells). On mobile each row is a card with visible labels (`.vk`).
- `#chart` has `role="img"` with a text summary. All numbers are also in the headline values and the table.
- Status is never shown by colour alone: there is text in every badge and note, and the spread bars also differ by direction.

## State board only (production can drop these)

- `?pseudo=` and `applyPseudo()` in `app.js`, which add `.is-hover`, `.is-focus` and `.is-focus-row`.
- The `postMessage({ type: 'pfa:height' })` block at the end of `app.js`, which lets `states.html` size its iframes.
- Everything below `/* ---------- state board (states.html) ---------- */` in `styles.css`.
- `states.html` itself.
