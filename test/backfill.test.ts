import { expect, test } from "bun:test";
import type { CandleSeries } from "../src/coinalyze/client.ts";
import { Backfill, OI_HISTORY_MAX_AGE_MS, rebuildPoints, type Bar } from "../src/funding/backfill.ts";
import { STALE_AFTER_MS } from "../src/funding/source.ts";
import type { ComponentStatus, HistoryPoint, MarketComponent, Snapshot } from "../src/types.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000; // on the minute grid

const component = (symbol: string | null, status: ComponentStatus, ratePeriodHours = 8): MarketComponent => ({
  venue: symbol ?? "UNLISTED",
  symbol,
  predicted_rate: null,
  rate_period_hours: ratePeriodHours,
  rate_8h: null,
  oi_usd: null,
  updated_at: null,
  status,
});

/** One 1-minute bar of `value` closing at each of `closes` (ms). */
const bars = (value: number, ...closes: number[]): Bar[] => closes.map((close) => ({ t: close / 1000 - 60, c: value }));
const minutes = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * MIN);

const COMPONENTS = [component("A", "used"), component("H", "used", 1), component("D", "no_rate"), component(null, "unlisted")];

const point = (timestamp: number, fields: Partial<HistoryPoint>): HistoryPoint => ({
  type: "snapshot",
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: 0.015,
  oi_weighted_predicted_funding_rate: 0.0175,
  markets: 2,
  open_interest_usd: 1000,
  unit: "percent_per_8h",
  source: "backfill",
  ...fields,
});

test("rebuilds a point per step inside the gap from the bars' closes, with the live methodology", () => {
  const closes = minutes(T0 + MIN, 3);
  const input = {
    coin: "ETH" as const,
    components: COMPONENTS,
    rates: new Map([["A", bars(0.02, ...closes)], ["H", bars(0.00125, ...closes)]]),
    openInterest: new Map([["A", bars(300, ...closes)], ["H", bars(100, ...closes)], ["D", bars(600, ...closes)]]),
    from: T0,
    to: T0 + 3 * MIN + 30_000,
    stepMs: MIN,
  };
  // H is hourly: 0.00125 → 0.01 per 8h. OI-weighted over the used venues; the total also counts no_rate D.
  expect(rebuildPoints(input)).toEqual([point(T0 + MIN, {}), point(T0 + 2 * MIN, {}), point(T0 + 3 * MIN, {})]);
  expect(rebuildPoints({ ...input, stepMs: 2 * MIN }).map((p) => p.timestamp)).toEqual([T0 + 2 * MIN]);
});

test("a rate counts for up to STALE_AFTER_MS after its bar closed, an open interest for up to OI_HISTORY_MAX_AGE_MS", () => {
  const t = T0 + MIN;
  const base = { coin: "ETH" as const, components: COMPONENTS, from: T0, to: t + 1, stepMs: MIN };
  const rates = new Map([["A", bars(0.02, t - STALE_AFTER_MS)], ["H", bars(0.00125, t - STALE_AFTER_MS - MIN)]]);
  const oldOi = t - OI_HISTORY_MAX_AGE_MS;

  // H's rate is too old, so only A is used; D's OI is too old, so the total is unknown.
  expect(
    rebuildPoints({ ...base, rates, openInterest: new Map([["A", bars(300, oldOi)], ["D", bars(600, oldOi - MIN)]]) }),
  ).toEqual([point(t, { aggregated_predicted_funding_rate: 0.02, oi_weighted_predicted_funding_rate: 0.02, markets: 1, open_interest_usd: null })]);

  // A used venue whose OI is too old leaves OI-weighted unknown as well.
  expect(rebuildPoints({ ...base, rates, openInterest: new Map([["A", bars(300, oldOi - MIN)], ["D", bars(600, t)]]) })[0]).toMatchObject({
    oi_weighted_predicted_funding_rate: null,
    open_interest_usd: null,
  });
});

test("a market without any OI series counts as omitted by the API, as in a live poll", () => {
  const closes = minutes(T0 + MIN, 1);
  const [p] = rebuildPoints({
    coin: "ETH",
    components: COMPONENTS,
    rates: new Map([["A", bars(0.02, ...closes)], ["H", bars(0.00125, ...closes)]]),
    openInterest: new Map([["H", bars(100, ...closes)], ["D", bars(600, ...closes)]]),
    from: T0,
    to: T0 + MIN + 1,
    stepMs: MIN,
  });
  // A has no OI: it leaves the weights and adds 0 to the total.
  expect(p).toEqual(point(T0 + MIN, { oi_weighted_predicted_funding_rate: 0.01, open_interest_usd: 700 }));
});

test("no point is rebuilt where no venue has a rate", () => {
  expect(
    rebuildPoints({ coin: "ETH", components: COMPONENTS, rates: new Map(), openInterest: new Map(), from: T0, to: T0 + 5 * MIN, stepMs: MIN }),
  ).toEqual([]);
});

const snapshot = (timestamp: number): Snapshot => ({
  type: "snapshot",
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: 0.02,
  oi_weighted_predicted_funding_rate: 0.02,
  markets: 1,
  open_interest_usd: 900,
  unit: "percent_per_8h",
  components: [component("A", "used"), component("K", "stale", 1), component("D", "no_rate"), component(null, "unlisted")],
});

const setup = (previous: number | null, opts: { fail?: boolean; now?: number } = {}) => {
  const calls: { kind: string; symbols: string[]; from: number; to: number }[] = [];
  const series = (symbols: string[], from: number, to: number, value: number): CandleSeries[] =>
    symbols.map((symbol) => ({
      symbol,
      history: Array.from({ length: Math.floor((to - from) / 60) }, (_, i) => {
        const t = from + i * 60;
        return { t, o: value, h: value, l: value, c: value };
      }),
    }));
  const client = {
    predictedFundingRateHistory: async (symbols: string[], from: number, to: number) => {
      calls.push({ kind: "rate", symbols, from, to });
      if (opts.fail) throw new Error("history down");
      return series(symbols.filter((s) => s === "A"), from, to, 0.02);
    },
    openInterestUsdHistory: async (symbols: string[], from: number, to: number) => {
      calls.push({ kind: "oi", symbols, from, to });
      return series(symbols, from, to, 300);
    },
  };
  const live = snapshot(T0);
  const { components: _, ...livePoint } = live;
  const history = previous === null ? [livePoint] : [{ ...livePoint, timestamp: previous }, livePoint];
  const added: HistoryPoint[] = [];
  const backfill = new Backfill({
    client,
    store: { history: () => history, addBackfill: (points) => void added.push(...points) },
    intervalMs: MIN,
    now: () => opts.now ?? T0,
  });
  return { calls, added, fill: () => backfill.fill([live]) };
};

test("a gap of more than 3 intervals is filled from the 1-minute history of the coin's markets", async () => {
  const { calls, added, fill } = setup(T0 - 10 * MIN);
  await fill();
  // Rates only for venues that report one (used or stale); OI for every listed market, from further back
  // because sparse markets report it less often. `to` lies ahead, so a request that waited for budget gets every bar.
  expect(calls).toEqual([
    { kind: "rate", symbols: ["A", "K"], from: (T0 - 10 * MIN - STALE_AFTER_MS) / 1000, to: T0 / 1000 + 3600 },
    { kind: "oi", symbols: ["A", "K", "D"], from: (T0 - 10 * MIN - OI_HISTORY_MAX_AGE_MS) / 1000, to: T0 / 1000 + 3600 },
  ]);
  expect(added.map((p) => p.timestamp)).toEqual(minutes(T0 - 9 * MIN, 9));
  expect(added.every((p) => p.source === "backfill" && p.open_interest_usd === 900)).toBe(true);
});

test("the rebuilt range runs until the rate history arrived, covering the polls the backfill itself delays", async () => {
  const { added, fill } = setup(T0 - 10 * MIN, { now: T0 + 150_000 });
  await fill();
  // T0 is the live point's timestamp; the store keeps the live point there.
  expect(added.map((p) => p.timestamp)).toEqual(minutes(T0 - 9 * MIN, 12));
});

test("only the last 24 h of a longer gap is filled, because Coinalyze keeps about 1500–2000 one-minute bars", async () => {
  const { calls, added, fill } = setup(T0 - 30 * 60 * MIN);
  await fill();
  expect(calls[0]!.from).toBe((T0 - 24 * 60 * MIN - STALE_AFTER_MS) / 1000);
  expect(added[0]!.timestamp).toBe(T0 - 24 * 60 * MIN + MIN);
  expect(added).toHaveLength(24 * 60 - 1);
});

test("only the first successful poll after startup is checked: no API call without a gap, never a second backfill, no throw on failure", async () => {
  for (const previous of [null, T0 - 3 * MIN]) {
    const { calls, fill } = setup(previous);
    await fill();
    expect(calls).toEqual([]);
  }
  // A backfill delays the next polls, so their own spacing must not trigger another one.
  const once = setup(T0 - 10 * MIN);
  await once.fill();
  await once.fill();
  expect(once.calls).toHaveLength(2);

  const failing = setup(T0 - 10 * MIN, { fail: true });
  await failing.fill();
  expect(failing.added).toEqual([]);
});
