import { ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, TickMarkType, type DeepPartial, type ISeriesApi, type LineData, type LineWidth, type PriceFormatCustom, type Time, type TimeChartOptions, type UTCTimestamp, type WhitespaceData } from "lightweight-charts";
import { isCoinSymbol, type CoinSymbol } from "../src/coins.ts";
import { STALE_AFTER_MS, VENUES } from "../src/funding/universe.ts"; // pure module: listed-venue count before the first snapshot, venue staleness
import { CLOSE, HISTORY_LIMIT, type ClientMessage, type ServerMessage } from "../src/protocol.ts";
import type { ComponentStatus, HistoryPoint, MarketComponent, Snapshot } from "../src/types.ts";

type Conn = "disconnected" | "connecting" | "connected" | "rejected";
type DataState = "waiting-data" | "waiting-oi" | "live" | "stale";

const TOKEN_KEY = "coinalyze.token";
/** Also read by the inline theme script in index.html. */
const THEME_KEY = "coinalyze.theme";
const RECONNECT_MS = 3000;
const WAIT_DATA = "waiting for data…";
const WAIT_OI = "waiting for open interest…";
const OFFLINE = "not connected";
const PENDING = "pending";

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const field = (row: HTMLElement, name: string) => row.querySelector(`[data-field="${name}"]`) as HTMLElement;

const app = $("#app");
const tokenForm = $<HTMLFormElement>("#token-form");
const tokenInput = $<HTMLInputElement>("#token-input");
const themeToggle = $("#theme-toggle");
const tokenToggle = $("#token-toggle");
const tokenConnect = $("#token-connect");
const tokenConnectLabel = $("#token-connect-label");
const tokenHelp = $("#token-help");
const connLabel = $("#conn-label");
const connNote = $("#conn-note");
const coinGroup = $("#coin-group");
const coinButtons = $$<HTMLButtonElement>('#coin-group [role="radio"]');
const coinBinds = $$('[data-bind="coin"]');
const usedCountBinds = $$('[data-bind="used-count"]');
const ageValue = $("#data-age-value");
const ageNote = $("#data-age-note");
const staleNoticeText = $("#stale-notice-text");
const kpis = $("#kpis");
const kpiAvg = $("#kpi-avg");
const kpiOi = $("#kpi-oi");
const kpiSpread = $("#kpi-spread");
const kpiVenues = $("#kpi-venues");
const kpiMarks = $("#kpi-venues-marks");
const kpiOiTotal = $("#kpi-oi-total");
const kpiOiTotalNote = $("#kpi-oi-total-note");
const historyWindow = $("#history-window");
const chartEl = $<HTMLDivElement>("#chart");
const chartStatus = $("#chart-status");
const legendBackfill = $("#legend-backfill");
const backfillNote = $("#history-backfill-note");
const venueTable = $("#venue-table");
const venuePlaceholderTitle = $("#venue-placeholder-title");
const venuePlaceholderText = $("#venue-placeholder-text");
const rowsUsed = $("#venue-rows-used");
const rowsExcluded = $("#venue-rows-excluded");
const sumUsedOi = $("#sum-used-oi");
const sumWeights = $("#sum-weights");
const sumAvg = $("#sum-avg");
const sumOi = $("#sum-oi");
const excludedCount = $("#venue-excluded-count");
const listedCount = $("#venue-listed-count");
const venueTotalOi = $("#venue-total-oi");
const dataAnnounce = $("#data-announce");
const venueRowTemplate = $<HTMLTemplateElement>("#tpl-venue-row").content.firstElementChild as HTMLElement;
const venueLineTemplate = $<HTMLTemplateElement>("#tpl-venue-line").content.firstElementChild as HTMLElement;

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let coins: CoinSymbol[] = [];
let intervalMs = Infinity;
let selected: CoinSymbol = "BTC";
let conn: Conn = "disconnected";
/** Connect was pressed with an empty token field. */
let tokenEmpty = false;
/** The data state of the last full render; the 1 s tick re-renders everything only when it changes. */
let renderedState: DataState | undefined;
let announced = "";
/** Venues of the selected coin whose arithmetic is open. */
const openVenues = new Set<string>();
const history = new Map<CoinSymbol, HistoryPoint[]>();
const latest = new Map<CoinSymbol, Snapshot>();
/** Three poll intervals: older data is flagged stale, and a longer pause between points is drawn as a gap. */
const staleAfterMs = () => 3 * intervalMs;

const send = (ws: WebSocket, msg: ClientMessage) => ws.send(JSON.stringify(msg));

/** Appends `point` to its coin's history; returns true when the oldest point was evicted. */
const record = (point: HistoryPoint): boolean => {
  const list = history.get(point.symbol) ?? [];
  list.push(point);
  history.set(point.symbol, list);
  if (list.length <= HISTORY_LIMIT) return false;
  list.splice(0, list.length - HISTORY_LIMIT);
  return true;
};

/** Merges points rebuilt after a restart into their coins' histories: ascending, the newest HISTORY_LIMIT kept. */
const mergeBackfill = (points: HistoryPoint[]): void => {
  const touched = new Set<CoinSymbol>();
  for (const p of points) {
    const list = history.get(p.symbol) ?? [];
    list.push(p);
    history.set(p.symbol, list);
    touched.add(p.symbol);
  }
  // No dedupe: the server sends only points absent from its memory, which this client mirrors.
  for (const symbol of touched) {
    const list = history.get(symbol)!;
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  }
};

// ---- Formatting -----------------------------------------------------------

/** Signed with U+2212; a value that rounds to zero carries no sign. */
const signed = (v: number, digits: number) => {
  const abs = Math.abs(v).toFixed(digits);
  return Number(abs) === 0 ? abs : `${v < 0 ? "−" : "+"}${abs}`;
};
const rate = (v: number | null) => (v === null ? "—" : signed(v, 5));
const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}K`);
const weightText = (w: number) => (w > 0 && w < 0.0005 ? "<0.1%" : `${(w * 100).toFixed(1)}%`);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 4s · 3m 34s · 2h 05m */
const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
};

/** Local 24 h clock. */
const clock = (ms: number, withSeconds: boolean) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ""}`;
};

const slug = (venue: string) => `venue-${venue.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

// ---- Derived state --------------------------------------------------------

/** Stale beats waiting-oi, so an old snapshot is always flagged. */
const dataState = (s: Snapshot | undefined): DataState =>
  !s ? "waiting-data" : Date.now() - s.timestamp > staleAfterMs() ? "stale" : s.oi_weighted_predicted_funding_rate === null ? "waiting-oi" : "live";

/** Shown wherever a value has not arrived yet. */
const pendingText = () => (conn === "disconnected" || conn === "rejected" ? OFFLINE : WAIT_DATA);

const listed = (s: Snapshot) => s.components.filter((c) => c.status !== "unlisted").length;

interface VenueRow {
  c: MarketComponent;
  used: boolean;
  /** Share of the used venues' open interest; null until every used venue has reported it. */
  weight: number | null;
  /** Number of used venues. */
  n: number;
  usedOi: number | null;
}

const STATUS_ORDER: Record<ComponentStatus, number> = { used: 0, stale: 1, unlisted: 2, no_rate: 3 };

/** Breakdown order: used venues, then stale, unlisted and no_rate ones, each group by open interest. */
const venueRows = (s: Snapshot): VenueRow[] => {
  const used = s.components.filter((c) => c.status === "used");
  const usedOi = used.every((c) => c.oi_usd !== null) ? used.reduce((sum, c) => sum + (c.oi_usd ?? 0), 0) : null;
  return s.components
    .map((c) => {
      const isUsed = c.status === "used";
      return { c, used: isUsed, weight: isUsed && usedOi ? (c.oi_usd ?? 0) / usedOi : null, n: used.length, usedOi };
    })
    .sort((a, b) => STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status] || (b.c.oi_usd ?? 0) - (a.c.oi_usd ?? 0));
};

const since = (c: MarketComponent) => (c.updated_at === null ? "" : ` ${duration(Date.now() - c.updated_at)}`);

const oiCounts = (c: MarketComponent) => (c.oi_usd === null ? WAIT_OI : `${usd(c.oi_usd)} still counts toward total open interest.`);

/** The arithmetic shown when a venue row is open. */
const detailLines = ({ c, weight, n, usedOi }: VenueRow): [string, string][] => {
  if (c.status === "used") {
    const r8 = c.rate_8h ?? 0; // FundingSource guarantees used ⇒ rate_8h !== null
    return [
      ["Rate / 8h", c.rate_period_hours === 8 ? `${rate(r8)}, already per 8h` : `${rate(c.predicted_rate)} per ${c.rate_period_hours}h × ${8 / c.rate_period_hours} = ${rate(r8)}`],
      ["→ AVG", `${rate(r8)} ÷ ${n} = ${rate(r8 / n)}`],
      ["→ OI-weighted", weight === null ? WAIT_OI : `${rate(r8)} × ${weightText(weight)} = ${rate(r8 * weight)}`],
      ["OI weight", weight === null || usedOi === null ? "pending until every used venue reports open interest" : `${usd(c.oi_usd ?? 0)} of ${usd(usedOi)} used open interest`],
    ];
  }
  if (c.status === "stale") {
    return [
      ["Why excluded", `Last update${since(c)} ago, older than the ${STALE_AFTER_MS / 60_000} min staleness limit.`],
      ["Last rate", `${rate(c.rate_8h)} per 8h, shown for reference only.`],
      ["Open interest", oiCounts(c)],
    ];
  }
  if (c.status === "unlisted") return [["Why excluded", `This market is not listed on ${c.venue}, so it has no rate and no open interest.`]];
  return [
    ["Why excluded", "No predicted rate from this venue, so it is outside AVG and OI-weighted."],
    ["Open interest", oiCounts(c)],
  ];
};

// ---- Render ---------------------------------------------------------------

const renderRoot = (s: Snapshot | undefined, state: DataState) => {
  app.dataset.conn = conn;
  app.dataset.data = state;
  for (const node of coinBinds) node.textContent = selected;
  const used = s ? String(s.components.filter((c) => c.status === "used").length) : "n";
  for (const node of usedCountBinds) node.textContent = used;
};

const renderGate = () => {
  const invalid = conn === "rejected" || tokenEmpty;
  tokenInput.setAttribute("aria-invalid", String(invalid));
  const busy = conn === "connecting";
  tokenConnect.setAttribute("aria-disabled", String(busy));
  tokenConnectLabel.textContent = busy ? "Connecting…" : "Connect";
  tokenHelp.textContent = tokenEmpty
    ? "Enter a token to connect."
    : conn === "rejected"
      ? "Token rejected by the service. Check it and connect again."
      : conn === "disconnected"
        ? "Paste the access token from your service config. It is remembered on this device."
        : "Remembered on this device, so a reload reconnects.";
  tokenHelp.dataset.tone = invalid ? "error" : "neutral";
};

const CONN_LABEL: Record<Conn, string> = { disconnected: "Disconnected", connecting: "Connecting…", connected: "Connected", rejected: "Rejected" };
const CONNECTED_NOTE: Record<DataState, string> = {
  "waiting-data": "Authenticated · no snapshot yet",
  "waiting-oi": "Live · waiting for open interest",
  live: "Live · authenticated WebSocket",
  stale: "Socket open · no new snapshot",
};

const renderConn = (state: DataState) => {
  connLabel.textContent = CONN_LABEL[conn];
  connNote.textContent =
    conn === "disconnected"
      ? "Enter a token to connect"
      : conn === "connecting"
        ? "Opening authenticated WebSocket…"
        : conn === "rejected"
          ? "The service refused this token"
          : CONNECTED_NOTE[state];
};

const renderCoins = () => {
  for (const button of coinButtons) {
    const on = button.dataset.coin === selected;
    button.setAttribute("aria-checked", String(on));
    button.tabIndex = on ? 0 : -1;
    const oi = latest.get(button.dataset.coin as CoinSymbol)?.oi_weighted_predicted_funding_rate ?? null;
    (button.querySelector("[data-coin-rate]") as HTMLElement).textContent = conn !== "connected" ? "—" : oi === null ? PENDING : rate(oi);
  }
};

const renderAge = (s: Snapshot | undefined, state: DataState) => {
  if (!s) {
    ageValue.textContent = "—";
    ageNote.textContent = conn === "connected" || conn === "connecting" ? "No snapshot yet" : "Not connected";
    staleNoticeText.textContent = "";
    return;
  }
  const age = duration(Date.now() - s.timestamp);
  ageValue.textContent = `${age} ago`;
  const stale = state === "stale";
  ageNote.textContent = stale ? `Stale · older than 3 poll intervals (${staleAfterMs() / 1000} s)` : `Fresh · snapshot at ${clock(s.timestamp, true)}`;
  staleNoticeText.textContent = stale
    ? `No new snapshot for ${age}, more than 3 poll intervals. The values below are the last ones received, at ${clock(s.timestamp, true)}.`
    : "";
};

const setValue = (node: HTMLElement, text: string, pending: boolean) => {
  node.textContent = text;
  node.dataset.pending = String(pending);
};

const renderKpis = (s: Snapshot | undefined) => {
  kpis.setAttribute("aria-label", `Headline values for ${selected}`);
  if (!s) {
    for (const node of [kpiAvg, kpiOi, kpiSpread, kpiVenues, kpiOiTotal]) setValue(node, pendingText(), true);
    kpiOiTotalNote.textContent = `USD · ${VENUES.length} listed venues`;
    kpiMarks.replaceChildren();
    return;
  }
  const avg = s.aggregated_predicted_funding_rate;
  const oi = s.oi_weighted_predicted_funding_rate;
  const total = s.open_interest_usd;
  setValue(kpiAvg, rate(avg), false);
  setValue(kpiOi, oi === null ? WAIT_OI : rate(oi), oi === null);
  setValue(kpiSpread, oi === null ? WAIT_OI : rate(oi - avg), oi === null);
  setValue(kpiVenues, `${s.markets} / ${s.components.length}`, false);
  setValue(kpiOiTotal, total === null ? WAIT_OI : usd(total), total === null);
  kpiOiTotalNote.textContent = `USD · ${listed(s)} listed venues`;
  kpiMarks.replaceChildren(
    ...venueRows(s).map(({ c }) => {
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.dataset.status = c.status;
      return mark;
    }),
  );
};

/** Contiguous runs of rebuilt points, as [first, last] timestamps. */
const backfillRuns = (points: HistoryPoint[]) => {
  const runs: [number, number][] = [];
  let run: [number, number] | undefined;
  for (const p of points) {
    if (p.source !== "backfill") {
      run = undefined;
    } else if (run === undefined) {
      run = [p.timestamp, p.timestamp];
      runs.push(run);
    } else {
      run[1] = p.timestamp;
    }
  }
  return runs;
};

/** The text around the chart; the series themselves are drawn by rebuildChart and pushPoint. */
const renderChartText = (s: Snapshot | undefined) => {
  const points = s ? (history.get(selected) ?? []) : [];
  const runs = backfillRuns(points);
  legendBackfill.hidden = runs.length === 0;
  backfillNote.hidden = runs.length === 0;
  const ranges = runs.map(([from, to]) => {
    const [first, last] = [clock(from, false), clock(to, false)];
    return first === last ? first : `${first}–${last}`;
  });
  backfillNote.textContent = runs.length === 0 ? "" : `Muted points ${ranges.join(", ")} were rebuilt from 1-minute history after a restart.`;
  chartStatus.textContent = pendingText();
  const oi = s?.oi_weighted_predicted_funding_rate ?? null;
  chartEl.setAttribute(
    "aria-label",
    s && points.length > 0
      ? `${historyWindow.textContent} history for ${selected}: AVG and OI-weighted lines, spread bars in the lower pane. Latest AVG ${rate(s.aggregated_predicted_funding_rate)}, OI-weighted ${oi === null ? WAIT_OI : rate(oi)} % per 8h.${runs.length > 0 ? " Includes rebuilt points." : ""}`
      : `History chart, ${pendingText()}`,
  );
};

const venueRow = (r: VenueRow) => {
  const { c } = r;
  const id = slug(c.venue);
  const open = openVenues.has(c.venue);
  const row = venueRowTemplate.cloneNode(true) as HTMLElement;
  row.id = id;
  row.dataset.venue = c.venue;
  row.dataset.status = c.status;
  row.dataset.open = String(open);
  const toggle = row.querySelector(".vtoggle") as HTMLElement;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", `${id}-detail`);
  field(row, "venue").textContent = c.venue;
  field(row, "symbol").textContent = c.symbol ?? "—";
  field(row, "predicted").textContent = rate(c.predicted_rate);
  field(row, "period").textContent = `${c.rate_period_hours}h`;
  field(row, "rate-8h").textContent = rate(c.rate_8h);
  field(row, "oi").textContent = c.oi_usd !== null ? usd(c.oi_usd) : c.status === "unlisted" ? "—" : "waiting…";
  const bar = field(row, "weight-bar");
  if (r.used) {
    const r8 = c.rate_8h ?? 0;
    field(row, "weight").textContent = r.weight === null ? PENDING : weightText(r.weight);
    bar.style.setProperty("--weight", r.weight === null ? "0%" : `${(r.weight * 100).toFixed(2)}%`);
    field(row, "to-avg").textContent = rate(r8 / r.n);
    field(row, "to-oi").textContent = r.weight === null ? PENDING : rate(r8 * r.weight);
  } else {
    field(row, "weight").textContent = "—";
    (bar.parentElement as HTMLElement).hidden = true;
    field(row, "to-avg").textContent = "—";
    field(row, "to-oi").textContent = "—";
  }
  field(row, "status").textContent =
    c.status === "used" ? "Used" : c.status === "stale" ? `Excluded · stale${since(c)}` : c.status === "unlisted" ? "Excluded · not listed" : "Excluded · no predicted rate";
  const detail = row.querySelector(".vdetail") as HTMLElement;
  detail.id = `${id}-detail`;
  detail.hidden = !open;
  detail.replaceChildren(
    ...detailLines(r).map(([key, value]) => {
      const line = venueLineTemplate.cloneNode(true) as HTMLElement;
      (line.querySelector(".vline-k") as HTMLElement).textContent = key;
      (line.querySelector(".vline-v") as HTMLElement).textContent = value;
      return line;
    }),
  );
  return row;
};

const renderVenues = (s: Snapshot | undefined) => {
  venuePlaceholderTitle.textContent = pendingText();
  venuePlaceholderText.textContent =
    conn === "disconnected" || conn === "rejected" ? "Connect with your access token to see how the ten venues produce AVG and OI-weighted." : "The breakdown appears with the first snapshot.";
  // Keeps keyboard focus on the same venue across a re-render.
  const focused = document.activeElement?.closest<HTMLElement>(".vrow-venue")?.dataset.venue;
  if (!s) {
    rowsUsed.replaceChildren();
    rowsExcluded.replaceChildren();
    return;
  }
  const rows = venueRows(s);
  const used = rows.filter((r) => r.used);
  const excluded = rows.filter((r) => !r.used);
  const usedOi = used[0]?.usedOi ?? null;
  const oi = s.oi_weighted_predicted_funding_rate;
  rowsUsed.replaceChildren(...used.map(venueRow));
  rowsExcluded.replaceChildren(...excluded.map(venueRow));
  sumUsedOi.textContent = usedOi === null ? PENDING : usd(usedOi);
  sumWeights.textContent = usedOi === null ? PENDING : "100%";
  sumAvg.textContent = rate(s.aggregated_predicted_funding_rate);
  sumOi.textContent = oi === null ? PENDING : rate(oi);
  excludedCount.textContent = String(excluded.length);
  listedCount.textContent = String(listed(s));
  venueTotalOi.textContent = s.open_interest_usd === null ? WAIT_OI : usd(s.open_interest_usd);
  if (focused !== undefined) (document.getElementById(slug(focused))?.querySelector(".vtoggle") as HTMLElement | null)?.focus();
};

/** Written only when the coin, connection, data state or empty-token error changes, so each transition is heard once. */
const renderAnnounce = (s: Snapshot | undefined, state: DataState) => {
  const key = `${selected}|${conn}|${state}|${tokenEmpty}`;
  if (key === announced) return;
  announced = key;
  dataAnnounce.textContent = tokenEmpty
    ? "Enter a token to connect."
    : conn === "disconnected"
      ? "Disconnected."
      : conn === "connecting"
        ? "Connecting."
        : conn === "rejected"
          ? "Token rejected."
          : state === "waiting-data"
            ? `${selected}: connected, waiting for data.`
            : state === "waiting-oi"
              ? `${selected}: AVG received, waiting for open interest.`
              : state === "stale"
                ? `${selected}: data is stale, last update ${duration(Date.now() - (s?.timestamp ?? Date.now()))} ago.`
                : `${selected}: live.`;
};

const render = () => {
  const s = latest.get(selected);
  const state = dataState(s);
  renderedState = state;
  renderRoot(s, state);
  renderGate();
  renderConn(state);
  renderCoins();
  renderAge(s, state);
  renderKpis(s);
  renderChartText(s);
  renderVenues(s);
  renderAnnounce(s, state);
};

const setConn = (next: Conn) => {
  conn = next;
  render();
};

// ---- Chart ----------------------------------------------------------------

/** Design tokens from `style.css`; the chart draws on a canvas and cannot use CSS directly. */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const px = (name: string) => Number.parseInt(cssVar(name), 10);

const localTime = (time: Time, withSeconds: boolean) => clock((time as UTCTimestamp) * 1000, withSeconds);

const localDate = (time: Time) =>
  new Date((time as UTCTimestamp) * 1000).toLocaleDateString([], { month: "short", day: "numeric" });

/** The theme-dependent chart options, at creation and on every theme switch; the tokens follow html[data-theme]. */
const themeOptions = (): DeepPartial<TimeChartOptions> => ({
  layout: {
    background: { type: ColorType.Solid, color: cssVar("--chart-bg") },
    textColor: cssVar("--chart-text"),
    panes: { separatorColor: cssVar("--chart-separator"), separatorHoverColor: cssVar("--chart-separator") },
  },
  grid: { vertLines: { color: cssVar("--chart-grid") }, horzLines: { color: cssVar("--chart-grid") } },
  crosshair: {
    vertLine: { color: cssVar("--chart-crosshair"), labelBackgroundColor: cssVar("--chart-crosshair-label") },
    horzLine: { color: cssVar("--chart-crosshair"), labelBackgroundColor: cssVar("--chart-crosshair-label") },
  },
});

const chart = createChart(chartEl, {
  autoSize: true,
  layout: { fontFamily: cssVar("--font-mono"), fontSize: px("--chart-font-size"), panes: { enableResize: false } },
  rightPriceScale: { borderVisible: false },
  timeScale: {
    borderVisible: false,
    timeVisible: true,
    secondsVisible: false,
    fixLeftEdge: true,
    fixRightEdge: true,
    // The library picks the tick type by UTC day; the label shows that point's local date.
    tickMarkFormatter: (t: Time, type: TickMarkType) => (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds ? localTime(t, false) : localDate(t)),
  },
  crosshair: { mode: CrosshairMode.Normal },
  localization: { timeFormatter: (t: Time) => `${localDate(t)} ${localTime(t, true)}` },
});
chart.applyOptions(themeOptions());

// Canvas text does not redraw when the web font arrives.
void document.fonts.load(`${px("--chart-font-size")}px ${cssVar("--font-mono")}`).then(() => chart.applyOptions({ layout: { fontFamily: cssVar("--font-mono") } }));

const priceFormat: PriceFormatCustom = { type: "custom", minMove: 0.00001, formatter: (p: number) => signed(p, 5) };
const lineWidth = (px("--chart-line-width") || 2) as LineWidth;

/** Series and per-point colours of the current theme; recolorChart re-reads them. */
const readColors = () => ({
  avg: cssVar("--chart-avg"),
  oi: cssVar("--chart-oi"),
  spreadPos: cssVar("--chart-spread-pos"),
  spreadNeg: cssVar("--chart-spread-neg"),
  avgBackfill: cssVar("--chart-avg-backfill"),
  oiBackfill: cssVar("--chart-oi-backfill"),
  spreadPosBackfill: cssVar("--chart-spread-pos-backfill"),
  spreadNegBackfill: cssVar("--chart-spread-neg-backfill"),
});
let colors = readColors();
const isBackfill = (p: HistoryPoint) => p.source === "backfill";

interface Track {
  series: ISeriesApi<"Line" | "Histogram">;
  pick: (p: HistoryPoint) => number | null;
  /** Per-point colour; `undefined` keeps the series colour. Rebuilt points get the muted `*-backfill` tokens. */
  color: (p: HistoryPoint, value: number) => string | undefined;
  lastTime: number;
}

const avgTrack: Track = {
  series: chart.addSeries(LineSeries, { color: colors.avg, lineWidth, priceFormat, priceLineVisible: false }),
  pick: (p) => p.aggregated_predicted_funding_rate,
  color: (p) => (isBackfill(p) ? colors.avgBackfill : undefined),
  lastTime: 0,
};
const oiTrack: Track = {
  series: chart.addSeries(LineSeries, { color: colors.oi, lineWidth, priceFormat, priceLineVisible: false }),
  pick: (p) => p.oi_weighted_predicted_funding_rate,
  color: (p) => (isBackfill(p) ? colors.oiBackfill : undefined),
  lastTime: 0,
};
const tracks: Track[] = [
  avgTrack,
  oiTrack,
  {
    series: chart.addSeries(HistogramSeries, { priceFormat, priceLineVisible: false }, 1),
    pick: (p) => (p.oi_weighted_predicted_funding_rate === null ? null : p.oi_weighted_predicted_funding_rate - p.aggregated_predicted_funding_rate),
    color: (p, v) => (isBackfill(p) ? (v < 0 ? colors.spreadNegBackfill : colors.spreadPosBackfill) : v < 0 ? colors.spreadNeg : colors.spreadPos),
    lastTime: 0,
  },
];
chart.panes()[1]?.setHeight(px("--chart-spread-pane"));

type ChartPoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

/**
 * One point per second (last value wins), ascending, as lightweight-charts requires, each coloured by `track.color`.
 * After any pause longer than staleAfterMs() a whitespace point marks the gap on the index-based time scale, and on
 * a line series the last valued point before it is transparent: a line series skips whitespace and strokes segment
 * i-1 → i in item i-1's colour, so that hides the segment joining across the downtime. Histogram bars before a gap
 * keep their colour. Gaps are detected from every point, including ones `pick` skips, so all tracks break together.
 */
const toPoints = (points: HistoryPoint[], track: Track): ChartPoint[] => {
  const line = track.series.seriesType() === "Line";
  const bySecond = new Map<number, ChartPoint>();
  let prev: number | undefined;
  let lastValued: LineData<UTCTimestamp> | undefined;
  for (const p of [...points].sort((a, b) => a.timestamp - b.timestamp)) {
    const time = Math.floor(p.timestamp / 1000) as UTCTimestamp;
    if (prev !== undefined && p.timestamp - prev > staleAfterMs()) {
      const gap = (Math.floor(prev / 1000) + 1) as UTCTimestamp;
      if (gap < time) bySecond.set(gap, { time: gap });
      if (line && lastValued !== undefined) lastValued.color = "transparent";
    }
    prev = p.timestamp;
    const value = track.pick(p);
    if (value !== null) {
      const color = track.color(p, value);
      lastValued = color === undefined ? { time, value } : { time, value, color };
      bySecond.set(time, lastValued);
    }
  }
  return [...bySecond.values()];
};

const rebuildChart = (fit = true) => {
  const points = history.get(selected) ?? [];
  for (const track of tracks) {
    const data = toPoints(points, track);
    track.series.setData(data);
    track.lastTime = data.at(-1)?.time ?? 0;
  }
  if (fit) chart.timeScale().fitContent();
};

const pushPoint = (p: HistoryPoint, evicted: boolean) => {
  // `p` is already recorded. After a pause longer than staleAfterMs() redraw everything so the gap whitespace is
  // inserted; after an eviction redraw so the series keeps HISTORY_LIMIT points.
  const prev = history.get(p.symbol)?.at(-2);
  const gap = prev !== undefined && p.timestamp - prev.timestamp > staleAfterMs();
  if (gap || evicted) {
    rebuildChart(gap); // an eviction keeps the user's zoom
    return;
  }
  const time = Math.floor(p.timestamp / 1000);
  for (const track of tracks) {
    const value = track.pick(p);
    // update() rejects points older than the last one.
    if (value === null || time < track.lastTime) continue;
    const point = { time: time as UTCTimestamp, value };
    const color = track.color(p, value);
    track.series.update(color === undefined ? point : { ...point, color });
    track.lastTime = time;
  }
};

/** Theme switch: re-reads the tokens and recolours the chart, rebuilt points included, keeping the user's zoom. */
const recolorChart = () => {
  colors = readColors();
  chart.applyOptions(themeOptions());
  avgTrack.series.applyOptions({ color: colors.avg });
  oiTrack.series.applyOptions({ color: colors.oi });
  rebuildChart(false);
};

// ---- Coins ----------------------------------------------------------------

const select = (coin: CoinSymbol) => {
  if (coin !== selected) openVenues.clear();
  selected = coin;
  render();
  rebuildChart();
};

/** Shows only the coins the server publishes and keeps a valid selection. */
const applyCoins = () => {
  for (const button of coinButtons) button.hidden = !coins.includes(button.dataset.coin as CoinSymbol);
  const initial = coins.includes(selected) ? selected : coins[0];
  if (initial !== undefined) select(initial);
};

coinGroup.addEventListener("click", (event) => {
  const coin = (event.target as HTMLElement).closest<HTMLElement>('[role="radio"]')?.dataset.coin ?? "";
  if (isCoinSymbol(coin)) select(coin);
});

// Radio group keyboard model: arrows move between visible coins (wrapping), Home/End jump; focus follows selection.
coinGroup.addEventListener("keydown", (event) => {
  const visible = coinButtons.filter((b) => !b.hidden);
  const index = visible.findIndex((b) => b.dataset.coin === selected);
  if (index === -1) return;
  const target =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? visible[(index + 1) % visible.length]
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? visible[(index - 1 + visible.length) % visible.length]
        : event.key === "Home"
          ? visible[0]
          : event.key === "End"
            ? visible.at(-1)
            : undefined;
  if (target === undefined) return;
  event.preventDefault();
  const coin = target.dataset.coin ?? "";
  if (isCoinSymbol(coin)) select(coin);
  target.focus();
});

// Opens or closes one venue's arithmetic without re-rendering the table.
venueTable.addEventListener("click", (event) => {
  const toggle = (event.target as HTMLElement).closest<HTMLElement>(".vtoggle");
  const row = toggle?.closest<HTMLElement>(".vrow-venue");
  const venue = row?.dataset.venue;
  if (!toggle || !row || venue === undefined) return;
  const open = !openVenues.has(venue);
  if (open) openVenues.add(venue);
  else openVenues.delete(venue);
  row.dataset.open = String(open);
  toggle.setAttribute("aria-expanded", String(open));
  ($(`#${toggle.getAttribute("aria-controls")}`) as HTMLElement).hidden = !open;
});

// ---- Connection -----------------------------------------------------------

const handle = (ws: WebSocket, msg: ServerMessage) => {
  switch (msg.type) {
    case "auth":
      if (msg.status === "ok") {
        conn = "connected";
        coins = msg.coins;
        intervalMs = msg.interval_ms;
        historyWindow.textContent = `${Math.max(1, Math.round((HISTORY_LIMIT * intervalMs) / 3_600_000))}h`;
        applyCoins();
      }
      return;
    case "history":
      history.clear();
      latest.clear();
      for (const p of msg.points) record(p);
      for (const s of msg.latest) latest.set(s.symbol, s);
      select(selected);
      return;
    case "backfill":
      mergeBackfill(msg.points);
      if (msg.points.some((p) => p.symbol === selected)) {
        // Fits the content: the gap's whitespace is gone, so the old logical range would show other times.
        rebuildChart();
        renderChartText(latest.get(selected));
      }
      return;
    case "ping":
      send(ws, { type: "pong" });
      return;
    case "error":
      console.warn(`server error: ${msg.message}`);
      return;
    case "snapshot": {
      const { components: _, ...point } = msg;
      const evicted = record(point);
      latest.set(msg.symbol, msg);
      if (msg.symbol === selected) pushPoint(point, evicted);
      render(); // other coins' rates update too
      return;
    }
  }
};

const connect = () => {
  clearTimeout(reconnectTimer);
  const token = tokenInput.value.trim();
  if (token === "") return;
  localStorage.setItem(TOKEN_KEY, token);

  if (socket !== null) {
    const old = socket;
    socket = null;
    old.close();
  }
  setConn("connecting");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => send(ws, { type: "auth", token });
  ws.onmessage = (event) => handle(ws, JSON.parse(String(event.data)) as ServerMessage);
  ws.onclose = (event) => {
    if (socket !== ws) return; // replaced by a newer connection
    socket = null;
    if (event.code === CLOSE.invalidToken) {
      // A rejected token shows nothing, not the data an earlier token received.
      history.clear();
      latest.clear();
      rebuildChart();
      setConn("rejected");
      return;
    }
    setConn("disconnected");
    reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  };
};

tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (conn === "connecting") return;
  tokenEmpty = tokenInput.value.trim() === "";
  if (tokenEmpty) {
    render();
    tokenInput.focus();
    return;
  }
  connect();
});

tokenInput.addEventListener("input", () => {
  if (!tokenEmpty) return;
  tokenEmpty = false;
  render();
});

tokenToggle.addEventListener("click", () => {
  const reveal = tokenInput.type === "password";
  tokenInput.type = reveal ? "text" : "password";
  tokenToggle.textContent = reveal ? "Hide" : "Show";
  tokenToggle.setAttribute("aria-pressed", String(reveal));
});

// ---- Theme ----------------------------------------------------------------
// The inline script in index.html sets html[data-theme] before the first paint: the stored choice, else
// prefers-color-scheme. Theme changes are not announced in #data-announce.

type Theme = "light" | "dark";
const darkScheme = matchMedia("(prefers-color-scheme: dark)");

const storedTheme = (): Theme | null => {
  const theme = localStorage.getItem(THEME_KEY);
  return theme === "light" || theme === "dark" ? theme : null;
};

const setTheme = (theme: Theme) => {
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  recolorChart();
};

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  setTheme(next);
});

// With no stored choice the page follows the system setting live.
darkScheme.addEventListener("change", (event) => {
  if (storedTheme() === null) setTheme(event.matches ? "dark" : "light");
});

// Another tab changed the stored choice.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY) setTheme(storedTheme() ?? (darkScheme.matches ? "dark" : "light"));
});

// Data age every second; a data-state change (e.g. to stale) re-renders everything.
setInterval(() => {
  const s = latest.get(selected);
  const state = dataState(s);
  if (state === renderedState) renderAge(s, state);
  else render();
}, 1000);

$("#history-tz").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"); // writes the switch's aria-pressed
render();

const stored = localStorage.getItem(TOKEN_KEY);
if (stored !== null) {
  tokenInput.value = stored;
  connect();
}
