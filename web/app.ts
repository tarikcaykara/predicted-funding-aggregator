import { ColorType, createChart, CrosshairMode, LineSeries, LineType, type ISeriesApi, type LineSeriesPartialOptions, type Time, type UTCTimestamp } from "lightweight-charts";
import { isCoinSymbol, type CoinSymbol } from "../src/coins.ts";
import { CLOSE, HISTORY_LIMIT, type ClientMessage, type ServerMessage } from "../src/protocol.ts";
import type { ComponentStatus, HistoryPoint, Snapshot } from "../src/types.ts";

type Status = "Connecting" | "Connected" | "Rejected" | "Disconnected";

const TOKEN_KEY = "coinalyze.token";
const RECONNECT_MS = 3000;
const STATUS_LABEL: Record<ComponentStatus, string> = {
  used: "used",
  stale: "stale",
  no_rate: "no predicted rate",
  unlisted: "not listed",
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const conn = $<HTMLElement>("#conn");
const connLabel = $<HTMLElement>("#conn-label");
const tokenForm = $<HTMLFormElement>("#token-form");
const tokenInput = $<HTMLInputElement>("#token-input");
const tokenToggle = $<HTMLButtonElement>("#token-toggle");
const connectButton = $<HTMLButtonElement>("#token-connect");
const tokenError = $<HTMLElement>("#token-error");
const tabs = [...document.querySelectorAll<HTMLButtonElement>("#tabs .tab")];
const chartEl = $<HTMLElement>("#chart");
const chartCoin = $<HTMLElement>("#chart-coin");
const venues = $<HTMLElement>("#venues");
const venueRows = $<HTMLElement>("#venue-rows");
const venueRow = $<HTMLTemplateElement>("#venue-row-tpl").content.firstElementChild as HTMLElement;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let coins: CoinSymbol[] = [];
let intervalMs = Infinity;
let selected: CoinSymbol = "ETH";
const history = new Map<CoinSymbol, HistoryPoint[]>();
const latest = new Map<CoinSymbol, Snapshot>();

const setStatus = (status: Status) => {
  conn.dataset.state = status.toLowerCase();
  connLabel.textContent = status;
  const rejected = status === "Rejected";
  tokenForm.dataset.invalid = String(rejected);
  tokenInput.setAttribute("aria-invalid", String(rejected));
  tokenError.hidden = !rejected;
  connectButton.disabled = status === "Connecting";
};

const send = (ws: WebSocket, msg: ClientMessage) => ws.send(JSON.stringify(msg));

const record = (point: HistoryPoint) => {
  const list = history.get(point.symbol) ?? [];
  list.push(point);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  history.set(point.symbol, list);
};

const signed = (v: number, digits: number) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

const tone = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "neutral");

// ---- KPIs -----------------------------------------------------------------

const formatAge = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

const renderKpi = (id: string, text: string | null, value: number | null, ts: number | null, note?: string) => {
  const kpi = $<HTMLElement>(id);
  const valueEl = kpi.querySelector(".kpi__value") as HTMLElement;
  const metaEl = kpi.querySelector(".kpi__meta") as HTMLElement;
  const waiting = text === null;
  kpi.dataset.state = waiting ? "waiting" : "ready";
  valueEl.textContent = text ?? "—";
  valueEl.dataset.tone = waiting || value === null ? "neutral" : tone(value);
  metaEl.textContent = ts === null ? "waiting for data…" : waiting && note !== undefined ? note : formatAge(Date.now() - ts);
  kpi.dataset.stale = String(!waiting && ts !== null && Date.now() - ts > 3 * intervalMs);
};

const renderKpis = () => {
  const s = latest.get(selected);
  const ts = s?.timestamp ?? null;
  const avg = s?.aggregated_predicted_funding_rate ?? null;
  const oi = s?.oi_weighted_predicted_funding_rate ?? null;
  renderKpi("#kpi-avg", avg === null ? null : `${signed(avg, 4)}%`, avg, ts);
  renderKpi("#kpi-oiw", oi === null ? null : `${signed(oi, 4)}%`, oi, ts, "waiting for open interest…");
  const spread = avg !== null && oi !== null ? oi - avg : null;
  renderKpi("#kpi-spread", spread === null ? null : `${signed(spread, 4)} pp`, spread, ts, "waiting for open interest…");
  renderKpi("#kpi-venues", s ? `${s.markets} / ${s.components.length}` : null, null, ts);
};

// ---- Per-venue breakdown --------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

const cell = (row: HTMLElement, selector: string) => row.querySelector(selector) as HTMLElement;

const renderVenues = () => {
  const s = latest.get(selected);
  if (!s) {
    venues.dataset.empty = "true";
    venueRows.replaceChildren();
    return;
  }
  venues.dataset.empty = "false";
  const oiTotal = s.components
    .filter((c) => c.status === "used")
    .reduce((sum, c) => sum + (c.oi_usd !== null && c.oi_usd > 0 ? c.oi_usd : 0), 0);
  // Outlier: |Per 8h − AVG| > 1σ (population) of the used venues' rates.
  const avg = s.aggregated_predicted_funding_rate;
  const rates = s.components.flatMap((c) => (c.status === "used" && c.rate_8h !== null ? [c.rate_8h] : []));
  const sigma = rates.length === 0 ? 0 : Math.sqrt(rates.reduce((sum, r) => sum + (r - avg) ** 2, 0) / rates.length);
  venueRows.replaceChildren(
    ...s.components.map((c) => {
      const used = c.status === "used";
      const weight = used && c.oi_usd !== null && c.oi_usd > 0 && oiTotal > 0 ? c.oi_usd / oiTotal : null;
      const row = venueRow.cloneNode(true) as HTMLElement;
      row.dataset.status = c.status;
      cell(row, ".vrow__venue").textContent = c.venue;
      cell(row, ".vrow__symbol").textContent = c.symbol ?? "—";
      cell(row, ".vrow__pred").textContent = c.predicted_rate === null ? "—" : `${signed(c.predicted_rate, 5)}%`;
      cell(row, ".vrow__period").textContent = `${c.rate_period_hours}h`;
      const p8 = cell(row, ".vrow__p8");
      cell(p8, ".p8-val").textContent = c.rate_8h === null ? "—" : `${signed(c.rate_8h, 4)}%`;
      p8.dataset.tone = c.rate_8h === null ? "neutral" : tone(c.rate_8h);
      const outlier = used && c.rate_8h !== null && Math.abs(c.rate_8h - avg) > sigma;
      p8.dataset.outlier = String(outlier);
      if (outlier) p8.title = "More than 1σ from AVG";
      cell(row, ".vrow__oi").textContent = c.oi_usd === null ? "—" : usd.format(c.oi_usd);
      cell(row, ".vrow__weight").textContent = weight === null ? "—" : `${(weight * 100).toFixed(1)}%`;
      cell(row, ".status").textContent = STATUS_LABEL[c.status];
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

/** Design tokens from `style.css`; the chart draws on a canvas and cannot use CSS directly. */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chartFontSize = Number.parseInt(cssVar("--fs-xs"), 10);

const chart = createChart($<HTMLDivElement>("#chart-canvas"), {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: cssVar("--color-chart-bg") },
    textColor: cssVar("--color-chart-text"),
    fontFamily: cssVar("--font-num"),
    fontSize: chartFontSize,
  },
  grid: { vertLines: { color: cssVar("--color-chart-grid") }, horzLines: { color: cssVar("--color-chart-grid") } },
  rightPriceScale: { borderColor: cssVar("--color-chart-grid"), scaleMargins: { top: 0.12, bottom: 0.12 } },
  timeScale: { borderColor: cssVar("--color-chart-grid"), timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time) => localTime(t, false) },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: cssVar("--color-chart-crosshair") }, horzLine: { color: cssVar("--color-chart-crosshair") } },
  localization: { timeFormatter: (t: Time) => localTime(t, true) },
});

// Canvas text does not redraw when the web font arrives.
void document.fonts.load(`${chartFontSize}px "IBM Plex Mono"`).then(() => chart.applyOptions({ layout: { fontFamily: cssVar("--font-num") } }));

const lineStyle: LineSeriesPartialOptions = {
  lineWidth: 2,
  lineType: LineType.WithSteps,
  priceFormat: { type: "custom", minMove: 0.0001, formatter: (p: number) => `${signed(p, 4)}%` },
  priceLineVisible: true,
  lastValueVisible: true,
};

interface Line {
  series: ISeriesApi<"Line">;
  pick: (p: HistoryPoint) => number | null;
  lastTime: number;
}

const lines: Line[] = [
  {
    series: chart.addSeries(LineSeries, { ...lineStyle, color: cssVar("--color-chart-avg"), title: "AVG" }),
    pick: (p) => p.aggregated_predicted_funding_rate,
    lastTime: 0,
  },
  {
    series: chart.addSeries(LineSeries, { ...lineStyle, color: cssVar("--color-chart-oiw"), title: "OI-w" }),
    pick: (p) => p.oi_weighted_predicted_funding_rate,
    lastTime: 0,
  },
];

/** One point per second (last value wins), ascending, as lightweight-charts requires. */
const toPoints = (points: HistoryPoint[], pick: Line["pick"]) => {
  const bySecond = new Map<number, number>();
  for (const p of [...points].sort((a, b) => a.timestamp - b.timestamp)) {
    const value = pick(p);
    if (value !== null) bySecond.set(Math.floor(p.timestamp / 1000), value);
  }
  return [...bySecond].map(([time, value]) => ({ time: time as UTCTimestamp, value }));
};

const rebuildChart = () => {
  const points = history.get(selected) ?? [];
  chartEl.dataset.empty = String(points.length === 0);
  for (const line of lines) {
    const data = toPoints(points, line.pick);
    line.series.setData(data);
    line.lastTime = data.at(-1)?.time ?? 0;
  }
  chart.timeScale().fitContent();
};

const pushPoint = (p: HistoryPoint) => {
  const time = Math.floor(p.timestamp / 1000);
  for (const line of lines) {
    const value = line.pick(p);
    // update() rejects points older than the last one.
    if (value === null || time < line.lastTime) continue;
    line.series.update({ time: time as UTCTimestamp, value });
    line.lastTime = time;
  }
};

// ---- Tabs -----------------------------------------------------------------

const select = (coin: CoinSymbol) => {
  selected = coin;
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.coin === coin));
  chartCoin.textContent = coin;
  renderKpis();
  renderVenues();
  rebuildChart();
};

/** Shows only the tabs of the coins the server publishes and keeps a valid selection. */
const applyCoins = () => {
  for (const tab of tabs) tab.hidden = !coins.includes(tab.dataset.coin as CoinSymbol);
  const initial = coins.includes(selected) ? selected : coins.includes("ETH") ? "ETH" : coins[0];
  if (initial !== undefined) select(initial);
};

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const coin = tab.dataset.coin ?? "";
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
        chartEl.dataset.empty = "false";
        pushPoint(point);
        renderKpis();
        renderVenues();
      }
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
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
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

setInterval(renderKpis, 1000);

select(selected);

const stored = localStorage.getItem(TOKEN_KEY);
if (stored !== null) {
  tokenInput.value = stored;
  connect();
}
