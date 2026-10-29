import type { CoinSymbol } from "../../src/coins.ts";
import { VENUES } from "../../src/funding/universe.ts";
import type { Snapshot } from "../../src/types.ts";
import type { PageVenue } from "./chart-page.ts";

export interface CoinSample {
  /** The chart legend "Aggregated Predicted Funding Rate · AVG close 10" (1-minute interval). */
  chart: number | null;
  page: PageVenue[];
  api: Snapshot | null;
}

export interface Sample {
  at: number;
  coins: Partial<Record<CoinSymbol, CoinSample>>;
}

export interface VenueCheck {
  venue: string;
  /** page% ÷ API value implied by the venue's ratePeriodHours. */
  expected: number;
  median: number | null;
  n: number;
  ok: boolean | null;
}

export interface LagFit {
  /** In samples for live series, in minutes for history series. */
  lag: number;
  mad: number;
  /** mean(chart − series) */
  bias: number;
  n: number;
}

export interface SeriesFit {
  atZero: LagFit | null;
  best: LagFit | null;
}

export interface CoinReport {
  coin: CoinSymbol;
  samples: number;
  meanChart: number | null;
  /** null when no sample read the page's venue table, so drift is unknown. */
  listing: { missingOnPage: string[]; extraOnPage: string[] } | null;
  venues: VenueCheck[];
  live: { name: string; fit: SeriesFit }[];
  history: { name: string; fit: SeriesFit }[];
}

/** One venue's 1-minute predicted-rate closes, as fetched from the API. */
export interface VenueHistory {
  ratePeriodHours: number;
  candles: { t: number; c: number }[];
}

/** Page values have 4 decimals; ratios of smaller values are rounding noise. */
const MIN_PAGE_VALUE = 0.0005;
const RATIO_TOLERANCE = 0.2;
/** A venue's last 1-minute close still counts this many minutes later (as STALE_AFTER_MS does live). */
const CARRY_MINUTES = 15;
const SMA_MINUTES = 10;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const fitOf = (lag: number, diffs: number[]): LagFit | null =>
  diffs.length === 0 ? null : { lag, mad: mean(diffs.map(Math.abs)), bias: mean(diffs), n: diffs.length };

/** Lowest MAD over lags 0..maxLag, considering only lags that keep at least half of the lag-0 pairs. */
const bestOf = (fitAt: (lag: number) => LagFit | null, maxLag: number): SeriesFit => {
  const atZero = fitAt(0);
  if (atZero === null) return { atZero: null, best: null };
  let best = atZero;
  for (let lag = 1; lag <= maxLag; lag++) {
    const fit = fitAt(lag);
    if (fit !== null && fit.n >= Math.ceil(atZero.n / 2) && fit.mad < best.mad) best = fit;
  }
  return { atZero, best };
};

/** Compares reference[i] with series[i − lag]: a positive lag means the reference trails the series. */
export const lagFit = (reference: (number | null)[], series: (number | null)[], lag: number): LagFit | null => {
  const diffs: number[] = [];
  for (let i = lag; i < reference.length; i++) {
    const r = reference[i];
    const s = series[i - lag];
    if (r !== null && r !== undefined && s !== null && s !== undefined) diffs.push(r - s);
  }
  return fitOf(lag, diffs);
};

export const bestLag = (reference: (number | null)[], series: (number | null)[], maxLag: number): SeriesFit =>
  bestOf((lag) => lagFit(reference, series, lag), maxLag);

/** Venue average per UNIX minute, normalized to 8h, carrying each venue's last close for CARRY_MINUTES. */
export const minuteAverage = (venues: VenueHistory[], fromMinute: number, toMinute: number): Map<number, number> => {
  const byMinute = venues.map((v) => {
    const closes = new Map<number, number>();
    for (const candle of v.candles) closes.set(Math.floor(candle.t / 60), (candle.c * 8) / v.ratePeriodHours);
    return closes;
  });
  const avg = new Map<number, number>();
  const last: ({ minute: number; value: number } | null)[] = venues.map(() => null);
  for (let m = fromMinute; m <= toMinute; m++) {
    const values: number[] = [];
    for (const [i, closes] of byMinute.entries()) {
      const value = closes.get(m);
      if (value !== undefined) last[i] = { minute: m, value };
      const l = last[i];
      if (l && m - l.minute <= CARRY_MINUTES) values.push(l.value);
    }
    if (values.length > 0) avg.set(m, mean(values));
  }
  return avg;
};

/** Chart at sample time vs the minute series `lag` minutes earlier, optionally as a trailing SMA. */
export const historyFit = (
  chart: { at: number; value: number }[],
  avgByMinute: Map<number, number>,
  lag: number,
  smaMinutes: number,
): LagFit | null => {
  const diffs: number[] = [];
  for (const { at, value } of chart) {
    const end = Math.floor(at / 60000) - lag;
    const window: number[] = [];
    for (let m = end - smaMinutes + 1; m <= end; m++) {
      const v = avgByMinute.get(m);
      if (v !== undefined) window.push(v);
    }
    if (window.length >= Math.ceil(smaMinutes / 2)) diffs.push(value - mean(window));
  }
  return fitOf(lag, diffs);
};

export const analyzeCoin = (
  samples: Sample[],
  coin: CoinSymbol,
  maxLagSamples: number,
  history: { avgByMinute: Map<number, number>; maxLagMinutes: number } | null,
): CoinReport => {
  const rows = samples.map((s) => s.coins[coin]);
  const chart = rows.map((r) => r?.chart ?? null);
  const pageMean = (pick: (v: PageVenue) => number | null) =>
    rows.map((r) => {
      const values = (r?.page ?? []).flatMap((v) => {
        const x = pick(v);
        return x === null ? [] : [x];
      });
      return values.length > 0 ? mean(values) : null;
    });

  const pageLabels = new Set(rows.flatMap((r) => (r?.page ?? []).map((v) => v.label)));
  const venueLabels = new Set(VENUES.map((v) => v.label));

  const venues = VENUES.map((venue): VenueCheck => {
    const ratios: number[] = [];
    for (const r of rows) {
      const page = r?.page.find((v) => v.label === venue.label)?.predicted ?? null;
      const api = r?.api?.components.find((c) => c.venue === venue.label)?.predicted_rate ?? null;
      if (page !== null && api !== null && api !== 0 && Math.abs(page) >= MIN_PAGE_VALUE) ratios.push(page / api);
    }
    const expected = 8 / venue.ratePeriodHours;
    const m = median(ratios);
    return {
      venue: venue.label,
      expected,
      median: m,
      n: ratios.length,
      ok: m === null ? null : Math.abs(m / expected - 1) <= RATIO_TOLERANCE,
    };
  });

  const chartPoints = samples.flatMap((s, i) => {
    const value = chart[i];
    return value === null || value === undefined ? [] : [{ at: s.at, value }];
  });
  const chartValues = chartPoints.map((p) => p.value);
  return {
    coin,
    samples: rows.filter((r) => r !== undefined).length,
    meanChart: chartValues.length > 0 ? mean(chartValues) : null,
    listing:
      pageLabels.size === 0
        ? null
        : {
            missingOnPage: [...venueLabels].filter((l) => !pageLabels.has(l)),
            extraOnPage: [...pageLabels].filter((l) => !venueLabels.has(l)),
          },
    venues,
    live: [
      {
        name: "API AVG (used venues)",
        fit: bestLag(chart, rows.map((r) => r?.api?.aggregated_predicted_funding_rate ?? null), maxLagSamples),
      },
      { name: "Page AVG (predicted only)", fit: bestLag(chart, pageMean((v) => v.predicted), maxLagSamples) },
      {
        name: "Page AVG of all 10 (current where predicted is n/a)",
        fit: bestLag(chart, pageMean((v) => v.predicted ?? v.current), maxLagSamples),
      },
    ],
    history:
      history === null
        ? []
        : [
            {
              name: "API AVG",
              fit: bestOf((lag) => historyFit(chartPoints, history.avgByMinute, lag, 1), history.maxLagMinutes),
            },
            {
              name: `${SMA_MINUTES}-minute SMA of API AVG`,
              fit: bestOf((lag) => historyFit(chartPoints, history.avgByMinute, lag, SMA_MINUTES), history.maxLagMinutes),
            },
          ],
  };
};

const pp = (v: number) => v.toFixed(5);
const pct = (mad: number, base: number | null) => (base ? ` (${((mad / Math.abs(base)) * 100).toFixed(1)}%)` : "");

const fitRows = (fits: { name: string; fit: SeriesFit }[], lagMinutes: number, meanChart: number | null) =>
  fits.map(({ name, fit }) => {
    const zero = fit.atZero ? `${pp(fit.atZero.mad)} pp${pct(fit.atZero.mad, meanChart)}` : "—";
    const best = fit.best
      ? `${+(fit.best.lag * lagMinutes).toFixed(1)} min | ${pp(fit.best.mad)} pp${pct(fit.best.mad, meanChart)} | ${pp(fit.best.bias)} pp | ${fit.best.n}`
      : "— | — | — | —";
    return `| ${name} | ${zero} | ${best} |`;
  });

export const formatReport = (reports: CoinReport[], samples: Sample[], gapMs: number): string => {
  const first = samples[0]?.at;
  const last = samples.at(-1)?.at;
  const span = first && last ? `${new Date(first).toISOString().slice(0, 16)} – ${new Date(last).toISOString().slice(11, 16)} UTC` : "";
  const lines = [`# Calibration report`, ``, `${samples.length} samples, ${gapMs / 1000}s apart, ${span}`];
  const fitHeader = [`| Series vs chart | MAD at lag 0 | Best lag | MAD at best lag | Bias (chart − series) | n |`, `|---|---|---|---|---|---|`];
  for (const r of reports) {
    lines.push(``, `## ${r.coin}`, ``);
    lines.push(
      r.listing === null
        ? `Listing: unknown, no sample read the venue table.`
        : r.listing.missingOnPage.length === 0 && r.listing.extraOnPage.length === 0
          ? `Listing: the page shows exactly the ${VENUES.length} venues in VENUES.`
          : `Listing drift: missing on page [${r.listing.missingOnPage.join(", ")}], not in VENUES [${r.listing.extraOnPage.join(", ")}].`,
      ``,
      `| Venue | Expected page ÷ API | Median page ÷ API | n | Check |`,
      `|---|---|---|---|---|`,
    );
    for (const v of r.venues) {
      const check = v.ok === null ? "no data" : v.ok ? "ok" : "MISMATCH";
      lines.push(`| ${v.venue} | ${v.expected} | ${v.median === null ? "—" : v.median.toFixed(3)} | ${v.n} | ${check} |`);
    }
    lines.push(``, `Live samples:`, ``, ...fitHeader, ...fitRows(r.live, gapMs / 60000, r.meanChart));
    if (r.history.length > 0) {
      lines.push(``, `API 1-minute history (lag search over past minutes):`, ``, ...fitHeader, ...fitRows(r.history, 1, r.meanChart));
    }
    lines.push(``, `Mean chart value: ${r.meanChart === null ? "—" : `${pp(r.meanChart)}%`} (${r.samples} samples).`);
  }
  return lines.join("\n");
};
