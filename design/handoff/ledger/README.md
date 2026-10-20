# Predicted Funding Aggregator — Ledger

Open `index.html` directly; it works offline.

- `styles.css` holds all design tokens in one `:root` block. Component rules use only tokens. Breakpoints: 1200 / 960 / 720 / 600px.
- `fonts.css` + `fonts/` contain IBM Plex Sans and Mono (latin, 400/500/600).
- `vendor/` contains lightweight-charts v5.2.1 (standalone).
- `demo.js` is a reference renderer. It sets the same attributes and text your TypeScript code should set.

## States (`index.html?state=…`)
disconnected · connecting · rejected · waiting-oi · live · live-sol · stale

## DOM contract
- `#conn[data-state]` takes `disconnected | connecting | connected | rejected`. `#conn-label` holds the text.
- `#token-form[data-invalid="true"]` and `#token-error` (`hidden` toggled) are used on reject. The toggle sets `input.type` and swaps its label between Show and Hide.
- `.tab[aria-selected]` marks the selected coin.
- Each `.kpi` has `data-state="waiting|ready"` and `data-stale="true|false"`. `.kpi__value[data-tone="pos|neg|neutral"]` holds the value; `.kpi__meta` holds the age or the waiting message.
- `#chart[data-empty]` and `#venues[data-empty]` hide content until the first snapshot arrives.
- Each venue row is a clone of `#venue-row-tpl`. Set `.vrow[data-status]` to `used | stale | no_rate | not_listed`. Set `.vrow__p8[data-tone][data-outlier]`; outlier means |Per 8h − AVG| > 1σ of the used venues. Below 960px CSS turns each row into a card, and `data-label` supplies the card labels.
- Chart colors come from `--color-chart-*`, read with `getComputedStyle`.
