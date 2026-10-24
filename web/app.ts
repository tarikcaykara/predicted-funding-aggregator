import { ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, TickMarkType, type ISeriesApi, type LineData, type LineWidth, type PriceFormatCustom, type Time, type UTCTimestamp, type WhitespaceData } from "lightweight-charts";
import { isCoinSymbol, type CoinSymbol } from "../src/coins.ts";
import { VENUES } from "../src/funding/universe.ts"; // pure module: placeholder pip count before the first snapshot
import { CLOSE, HISTORY_LIMIT, type ClientMessage, type ServerMessage } from "../src/protocol.ts";
import type { ComponentStatus, HistoryPoint, MarketComponent, Snapshot } from "../src/types.ts";

type Status = "Connecting" | "Connected" | "Rejected" | "Disconnected";
type DataState = "waiting-data" | "waiting-oi" | "live" | "stale";

const TOKEN_KEY = "coinalyze.token";
const RECONNECT_MS = 3000;
const WAIT_DATA = "waiting for data…";
const WAIT_OI = "waiting for open interest…";
const STATUS_LABEL: Record<ComponentStatus, string> = {
  used: "Used",
  stale: "Excluded · stale",
  no_rate: "Excluded · no predicted rate",
  unlisted: "Excluded · not listed",
};
const CONN_DETAIL: Record<Status, string> = {
  Disconnected: "Enter a token and connect.",
  Connecting: "Opening live connection…",
  Connected: "Live",
  Rejected: "Token rejected. Check it and connect again.",
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const $$ = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const cell = (root: HTMLElement, selector: string) => root.querySelector(selector) as HTMLElement;

const app = $<HTMLElement>("#app");
const tokenForm = $<HTMLFormElement>("#auth");
const tokenInput = $<HTMLInputElement>("#token");
const tokenToggle = $<HTMLButtonElement>("#toggle");
const connectButton = $<HTMLButtonElement>("#connect");
const connDetail = $<HTMLElement>("#conn-detail");
const connLabels = $$<HTMLElement>("[data-conn-label]");
const coinButtons = $$<HTMLButtonElement>("#coins .coin");
const coinLabels = $$<HTMLElement>("[data-coin-label]");
const age = $<HTMLElement>("#age");
const pips = $<HTMLElement>("#pips");
const historyWindow = $<HTMLElement>("#history-window");
const venues = $<HTMLElement>("#venues");
const venueRows = $<HTMLElement>("#venue-rows");
const venueRow = $<HTMLTemplateElement>("#venue-row").content.firstElementChild as HTMLElement;
const axisMin = $<HTMLElement>("[data-axis-min]");
const axisMax = $<HTMLElement>("[data-axis-max]");
const axisOi = $<HTMLElement>(".axis__oi");

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let coins: CoinSymbol[] = [];
let intervalMs = Infinity;
let selected: CoinSymbol = "BTC";
const history = new Map<CoinSymbol, HistoryPoint[]>();
const latest = new Map<CoinSymbol, Snapshot>();
/** Three poll intervals: older data is flagged STALE, and a longer pause between points is drawn as a gap. */
const staleAfterMs = () => 3 * intervalMs;

const setStatus = (status: Status) => {
  app.dataset.conn = status.toLowerCase();
  for (const label of connLabels) label.textContent = status;
  connDetail.textContent = CONN_DETAIL[status];
  tokenInput.setAttribute("aria-invalid", String(status === "Rejected"));
  const connecting = status === "Connecting";
  connectButton.disabled = connecting;
  connectButton.textContent = connecting ? "Connecting…" : "Connect";
};

const send = (ws: WebSocket, msg: ClientMessage) => ws.send(JSON.stringify(msg));

const record = (point: HistoryPoint) => {
  const list = history.get(point.symbol) ?? [];
  list.push(point);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  history.set(point.symbol, list);
};

// ---- Formatting -----------------------------------------------------------

const signed = (v: number, digits: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(digits)}`; // U+2212
const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}K`);
const signClass = (v: number) => (v < 0 ? "is-neg" : "is-pos");
const weightText = (w: number) => (w > 0 && w < 0.0005 ? "<0.1%" : `${(w * 100).toFixed(1)}%`);

const formatAge = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

// ---- Headline -------------------------------------------------------------

/** Stale beats waiting-oi, so an old snapshot is always flagged. */
const dataState = (s: Snapshot | undefined): DataState =>
  !s ? "waiting-data" : Date.now() - s.timestamp > staleAfterMs() ? "stale" : s.oi_weighted_predicted_funding_rate === null ? "waiting-oi" : "live";

const setMetric = (id: string, text: string, note: string | null, tone: string, waiting: boolean) => {
  const value = $<HTMLElement>(`#${id}`);
  value.textContent = text;
  value.className = `metric__value ${waiting ? "is-waiting" : tone}`;
  if (note === null) return;
  const noteEl = $<HTMLElement>(`#${id}-note`);
  noteEl.textContent = note;
  noteEl.className = `metric__note${waiting ? " is-waiting" : ""}`;
};

const renderHeadline = () => {
  const s = latest.get(selected);
  app.dataset.data = dataState(s);
  for (const button of coinButtons) {
    const oi = latest.get(button.dataset.coin as CoinSymbol)?.oi_weighted_predicted_funding_rate ?? null;
    cell(button, ".coin__val").textContent = oi === null ? "—" : signed(oi, 5);
  }
  age.textContent = s ? formatAge(Date.now() - s.timestamp) : "—";
  if (!s) {
    for (const id of ["m-avg", "m-oi", "m-sp"]) setMetric(id, "—", WAIT_DATA, "", true);
    setMetric("m-ven", "—", null, "", true);
    pips.replaceChildren(...VENUES.map(() => Object.assign(document.createElement("span"), { className: "pip" })));
    return;
  }
  const avg = s.aggregated_predicted_funding_rate;
  const oi = s.oi_weighted_predicted_funding_rate;
  setMetric("m-avg", signed(avg, 5), `% per 8h · ${avg < 0 ? "negative" : "positive"}`, signClass(avg), false);
  if (oi === null) {
    setMetric("m-oi", "—", WAIT_OI, "", true);
    setMetric("m-sp", "—", WAIT_OI, "", true);
  } else {
    const sp = oi - avg;
    setMetric("m-oi", signed(oi, 5), `% per 8h · ${oi < 0 ? "negative" : "positive"}`, signClass(oi), false);
    setMetric("m-sp", signed(sp, 5), "pp · OI-weighted − AVG", signClass(sp), false);
  }
  setMetric("m-ven", `${s.markets} / ${s.components.length}`, null, "", false);
  pips.replaceChildren(...s.components.map((c) => Object.assign(document.createElement("span"), { className: c.status === "used" ? "pip pip--used" : "pip pip--excluded" })));
};

// ---- Per-venue number line ------------------------------------------------

/** `FundingSource.component` guarantees used ⇒ rate_8h !== null; the guard only narrows the type. */
const onLine = (c: MarketComponent): c is MarketComponent & { rate_8h: number } => c.status === "used" && c.rate_8h !== null;

const renderVenues = () => {
  venueRows.replaceChildren();
  const s = latest.get(selected);
  if (!s) return; // CSS hides the table on waiting-data
  const avg = s.aggregated_predicted_funding_rate;
  const oi = s.oi_weighted_predicted_funding_rate;
  const used = s.components.filter(onLine).sort((a, b) => b.rate_8h - a.rate_8h);
  const rows = [...used, ...s.components.filter((c) => !onLine(c))];
  const oiSum = used.reduce((sum, c) => sum + (c.oi_usd ?? 0), 0);

  // Shared axis over every on-line rate, AVG, OI-weighted and zero.
  const vals = [...used.map((c) => c.rate_8h), avg, 0, ...(oi === null ? [] : [oi])];
  let mn = Math.min(...vals);
  let mx = Math.max(...vals);
  const pad = (mx - mn) * 0.08 || 0.0001; // guards a zero span
  mn -= pad;
  mx += pad;
  const pos = (v: number) => `${(((v - mn) / (mx - mn)) * 100).toFixed(2)}%`;
  venues.style.setProperty("--zero", pos(0));
  venues.style.setProperty("--avg", pos(avg));
  if (oi !== null) venues.style.setProperty("--oi", pos(oi));
  const near = (v: number) => Math.abs(v) / (mx - mn) < 0.1;
  const minT = near(mn) ? "" : signed(mn, 4);
  const maxT = near(mx) ? "" : signed(mx, 4);
  axisMin.textContent = minT;
  axisMax.textContent = maxT;
  axisOi.hidden = oi === null;

  venueRows.append(
    ...rows.map((c) => {
      const live = onLine(c);
      const w = oi !== null && live && c.oi_usd !== null && oiSum > 0 ? c.oi_usd / oiSum : null;
      const row = venueRow.cloneNode(true) as HTMLElement;
      row.dataset.status = c.status;
      if (c.status !== "used") row.classList.add("is-excluded");
      if (c.rate_8h !== null && c.rate_8h < 0) row.classList.add("is-neg-rate");
      cell(row, ".v__name").textContent = c.venue;
      cell(row, ".v__sym").textContent = c.symbol ?? "—";
      cell(row, ".v__pred").textContent = c.predicted_rate === null ? "—" : signed(c.predicted_rate, 5);
      cell(row, ".v__per").textContent = `${c.rate_period_hours}h`;
      const r8 = cell(row, ".v__r8-val");
      r8.textContent = c.rate_8h === null ? "—" : signed(c.rate_8h, 4);
      if (live) r8.className = `v__r8-val ${signClass(c.rate_8h)}`;
      // The design shows "—" for every OI cell until OI-weighted exists.
      cell(row, ".v__oi").textContent = oi === null || c.oi_usd === null ? "—" : usd(c.oi_usd);
      cell(row, ".v__w").textContent = w === null ? "—" : weightText(w);
      cell(row, ".tick-min").textContent = minT;
      cell(row, ".tick-max").textContent = maxT;
      cell(row, ".track__oi").hidden = oi === null;
      cell(row, ".tick-oi").hidden = oi === null;
      cell(row, ".badge").textContent = STATUS_LABEL[c.status];
      if (live) {
        const track = cell(row, ".track");
        track.style.setProperty("--x", pos(c.rate_8h));
        track.style.setProperty("--w", w === null ? "0.3" : Math.sqrt(w).toFixed(3)); // dot area ∝ weight
      }
      return row;
    }),
  );
};

// ---- Chart ----------------------------------------------------------------

const localTime = (time: Time, withSeconds: boolean) =>
  new Date((time as UTCTimestamp) * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });

const localDate = (time: Time) =>
  new Date((time as UTCTimestamp) * 1000).toLocaleDateString([], { month: "short", day: "numeric" });

/** Design tokens from `style.css`; the chart draws on a canvas and cannot use CSS directly. */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const px = (name: string) => Number.parseInt(cssVar(name), 10);

const chart = createChart($<HTMLDivElement>("#chart"), {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: "transparent" },
    textColor: cssVar("--chart-text"),
    fontFamily: cssVar("--font-mono"),
    fontSize: px("--chart-font-size"),
  },
  grid: { vertLines: { color: cssVar("--chart-grid") }, horzLines: { color: cssVar("--chart-grid") } },
  rightPriceScale: { borderVisible: false },
  timeScale: {
    borderVisible: false,
    timeVisible: true,
    secondsVisible: false,
    // The library picks the tick type by UTC day; the label shows that point's local date.
    tickMarkFormatter: (t: Time, type: TickMarkType) => (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds ? localTime(t, false) : localDate(t)),
  },
  crosshair: { mode: CrosshairMode.Normal },
  localization: { timeFormatter: (t: Time) => `${localDate(t)} ${localTime(t, true)}` },
});

// Canvas text does not redraw when the web font arrives.
void document.fonts.load(`${px("--chart-font-size")}px "JetBrains Mono"`).then(() => chart.applyOptions({ layout: { fontFamily: cssVar("--font-mono") } }));

const priceFormat: PriceFormatCustom = { type: "custom", minMove: 0.00001, formatter: (p: number) => signed(p, 4) };
const lineWidth = (px("--chart-line-width") || 2) as LineWidth;
const spreadPos = cssVar("--chart-spread-pos");
const spreadNeg = cssVar("--chart-spread-neg");

interface Track {
  series: ISeriesApi<"Line" | "Histogram">;
  pick: (p: HistoryPoint) => number | null;
  /** Per-point colour (spread bars). */
  tint?: (v: number) => string;
  lastTime: number;
}

const tracks: Track[] = [
  {
    series: chart.addSeries(LineSeries, { color: cssVar("--chart-avg"), lineWidth, priceFormat, priceLineVisible: false, title: "AVG" }),
    pick: (p) => p.aggregated_predicted_funding_rate,
    lastTime: 0,
  },
  {
    series: chart.addSeries(LineSeries, { color: cssVar("--chart-oi"), lineWidth, priceFormat, priceLineVisible: false, title: "OI-w" }),
    pick: (p) => p.oi_weighted_predicted_funding_rate,
    lastTime: 0,
  },
  {
    series: chart.addSeries(HistogramSeries, { priceFormat, priceLineVisible: false, title: "Spread" }, 1),
    pick: (p) => (p.oi_weighted_predicted_funding_rate === null ? null : p.oi_weighted_predicted_funding_rate - p.aggregated_predicted_funding_rate),
    tint: (v) => (v < 0 ? spreadNeg : spreadPos),
    lastTime: 0,
  },
];
chart.panes()[1]?.setHeight(px("--chart-spread-pane"));

type ChartPoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

/**
 * One point per second (last value wins), ascending, as lightweight-charts requires. After any pause longer than
 * staleAfterMs() a whitespace point marks the gap on the index-based time scale, and the last valued point before it
 * is transparent: a line series skips whitespace and strokes segment i-1 → i in item i-1's colour, so that hides the
 * segment joining across the downtime. Gaps are detected from every point, including ones `pick` skips, so all
 * tracks break together.
 */
const toPoints = (points: HistoryPoint[], pick: Track["pick"]): ChartPoint[] => {
  const bySecond = new Map<number, ChartPoint>();
  let prev: number | undefined;
  let lastValued: LineData<UTCTimestamp> | undefined;
  for (const p of [...points].sort((a, b) => a.timestamp - b.timestamp)) {
    const time = Math.floor(p.timestamp / 1000) as UTCTimestamp;
    if (prev !== undefined && p.timestamp - prev > staleAfterMs()) {
      const gap = (Math.floor(prev / 1000) + 1) as UTCTimestamp;
      if (gap < time) bySecond.set(gap, { time: gap });
      if (lastValued !== undefined) lastValued.color = "transparent";
    }
    prev = p.timestamp;
    const value = pick(p);
    if (value !== null) {
      lastValued = { time, value };
      bySecond.set(time, lastValued);
    }
  }
  return [...bySecond.values()];
};

const rebuildChart = () => {
  const points = history.get(selected) ?? [];
  for (const track of tracks) {
    const data = toPoints(points, track.pick);
    const { tint } = track;
    track.series.setData(tint === undefined ? data : data.map((d) => ("value" in d ? { ...d, color: tint(d.value) } : d)));
    track.lastTime = data.at(-1)?.time ?? 0;
  }
  chart.timeScale().fitContent();
};

const pushPoint = (p: HistoryPoint) => {
  // `p` is already recorded; after a pause longer than staleAfterMs() redraw everything so the gap whitespace is inserted.
  const prev = history.get(p.symbol)?.at(-2);
  if (prev !== undefined && p.timestamp - prev.timestamp > staleAfterMs()) {
    rebuildChart();
    return;
  }
  const time = Math.floor(p.timestamp / 1000);
  for (const track of tracks) {
    const value = track.pick(p);
    // update() rejects points older than the last one.
    if (value === null || time < track.lastTime) continue;
    const point = { time: time as UTCTimestamp, value };
    track.series.update(track.tint === undefined ? point : { ...point, color: track.tint(value) });
    track.lastTime = time;
  }
};

// ---- Coins ----------------------------------------------------------------

const select = (coin: CoinSymbol) => {
  selected = coin;
  for (const button of coinButtons) button.setAttribute("aria-selected", String(button.dataset.coin === coin));
  for (const label of coinLabels) label.textContent = coin;
  renderHeadline();
  renderVenues();
  rebuildChart();
};

/** Shows only the coins the server publishes and keeps a valid selection. */
const applyCoins = () => {
  for (const button of coinButtons) button.hidden = !coins.includes(button.dataset.coin as CoinSymbol);
  const initial = coins.includes(selected) ? selected : coins[0];
  if (initial !== undefined) select(initial);
};

for (const button of coinButtons) {
  button.addEventListener("click", () => {
    const coin = button.dataset.coin ?? "";
    if (isCoinSymbol(coin)) select(coin);
  });
}

// ---- Connection -----------------------------------------------------------

const handle = (ws: WebSocket, msg: ServerMessage) => {
  switch (msg.type) {
    case "auth":
      if (msg.status === "ok") {
        setStatus("Connected");
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
    case "ping":
      send(ws, { type: "pong" });
      return;
    case "error":
      console.warn(`server error: ${msg.message}`);
      return;
    case "snapshot": {
      const { components: _, ...point } = msg;
      record(point);
      latest.set(msg.symbol, msg);
      if (msg.symbol === selected) {
        pushPoint(point);
        renderVenues();
      }
      renderHeadline(); // other coins' buttons update too
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
  setStatus("Connecting");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => send(ws, { type: "auth", token });
  ws.onmessage = (event) => handle(ws, JSON.parse(String(event.data)) as ServerMessage);
  ws.onclose = (event) => {
    if (socket !== ws) return; // replaced by a newer connection
    socket = null;
    if (event.code === CLOSE.invalidToken) {
      setStatus("Rejected");
      return;
    }
    setStatus("Disconnected");
    reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  };
};

tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (tokenInput.value.trim() === "") {
    tokenInput.focus();
    return;
  }
  connect();
});

tokenToggle.addEventListener("click", () => {
  const reveal = tokenInput.type === "password";
  tokenInput.type = reveal ? "text" : "password";
  tokenToggle.textContent = reveal ? "Hide" : "Show";
  tokenToggle.setAttribute("aria-pressed", String(reveal));
  tokenToggle.setAttribute("aria-label", reveal ? "Hide token" : "Show token");
});

setInterval(renderHeadline, 1000);

select(selected);

const stored = localStorage.getItem(TOKEN_KEY);
if (stored !== null) {
  tokenInput.value = stored;
  connect();
}
