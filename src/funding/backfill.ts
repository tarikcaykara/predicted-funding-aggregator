import type { CandleSeries, CoinalyzeClient } from "../coinalyze/client.ts";
import { COIN_REGISTRY, type CoinSymbol } from "../coins.ts";
import { createLogger, errorMessage } from "../log.ts";
import type { SnapshotStore } from "../store.ts";
import type { HistoryPoint, MarketComponent, Snapshot } from "../types.ts";
import { aggregate } from "./aggregate.ts";
import { STALE_AFTER_MS } from "./source.ts";

const log = createLogger("backfill");

const MINUTE_MS = 60_000;
/** Coinalyze keeps 1500–2000 one-minute bars, so only the last day of a gap can be rebuilt. */
export const BACKFILL_MAX_MS = 24 * 60 * MINUTE_MS;
/** Consecutive points further apart than this many intervals are a gap, as on the dashboard and in /health. */
const GAP_INTERVALS = 3;
/**
 * An open interest bar counts for this long. Live polls use whatever OI value the API reports, and sparse markets
 * publish OI bars rarely (WOO X: 10 bars an hour, up to 16 min apart, measured 2026-11-03).
 */
export const OI_HISTORY_MAX_AGE_MS = 60 * MINUTE_MS;
/** History requests ask for bars up to this far ahead, so a request that waited for API budget still gets every bar. */
const REQUEST_AHEAD_S = 3600;

/** A 1-minute bar: `t` is its open time in UNIX seconds, `c` its close. */
export type Bar = Pick<CandleSeries["history"][number], "t" | "c">;

/** Close of the newest bar that closed at `at` (a whole minute) or up to `maxAgeMs` before it. */
const valueAt = (closes: Map<number, number> | undefined, at: number, maxAgeMs: number): number | null => {
  for (let close = at; closes !== undefined && close >= at - maxAgeMs; close -= MINUTE_MS) {
    const value = closes.get(close);
    if (value !== undefined) return value;
  }
  return null;
};

const closesBySymbol = (series: Map<string, Bar[]>) =>
  new Map([...series].map(([symbol, bars]) => [symbol, new Map(bars.map((b) => [(b.t + 60) * 1000, b.c]))]));

/**
 * Rebuilds one coin's points at whole minutes `stepMs` apart, strictly between `from` and `to`, from 1-minute bars,
 * with the live rules: a rate counts for up to STALE_AFTER_MS after its bar closed, an open interest for up to
 * OI_HISTORY_MAX_AGE_MS; a market without any OI series was omitted by the API, so it adds 0 and leaves the weights.
 */
export const rebuildPoints = (opts: {
  coin: CoinSymbol;
  components: MarketComponent[];
  rates: Map<string, Bar[]>;
  openInterest: Map<string, Bar[]>;
  from: number;
  to: number;
  stepMs: number;
}): HistoryPoint[] => {
  const rates = closesBySymbol(opts.rates);
  const oi = closesBySymbol(opts.openInterest);
  const listed = opts.components.flatMap((c) => (c.symbol === null ? [] : [{ symbol: c.symbol, period: c.rate_period_hours }]));
  const points: HistoryPoint[] = [];
  for (let at = Math.floor(opts.from / MINUTE_MS) * MINUTE_MS + opts.stepMs; at < opts.to; at += opts.stepMs) {
    const entries: { rate: number; oiUsd: number | null }[] = [];
    let weightsComplete = true;
    let total: number | null = 0;
    for (const { symbol, period } of listed) {
      const omitted = !oi.has(symbol);
      const oiUsd = omitted ? null : valueAt(oi.get(symbol), at, OI_HISTORY_MAX_AGE_MS);
      if (!omitted && oiUsd === null) total = null;
      else if (total !== null) total += oiUsd ?? 0;
      const rate = valueAt(rates.get(symbol), at, STALE_AFTER_MS);
      if (rate === null) continue;
      if (!omitted && oiUsd === null) weightsComplete = false;
      entries.push({ rate: (rate * 8) / period, oiUsd });
    }
    const result = aggregate(entries);
    if (result.avg === null) continue;
    points.push({
      type: "snapshot",
      symbol: opts.coin,
      coin: COIN_REGISTRY[opts.coin].slug,
      timestamp: at,
      aggregated_predicted_funding_rate: result.avg,
      oi_weighted_predicted_funding_rate: weightsComplete ? result.oiWeighted : null,
      markets: result.count,
      open_interest_usd: total,
      unit: "percent_per_8h",
      source: "backfill",
    });
  }
  return points;
};

/**
 * After a restart, fills the gap before each coin's first new point from Coinalyze's 1-minute history of the coin's
 * markets, once per process.
 */
export class Backfill {
  private readonly client: Pick<CoinalyzeClient, "predictedFundingRateHistory" | "openInterestUsdHistory">;
  private readonly store: Pick<SnapshotStore, "history" | "addBackfill">;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private checked = false;

  constructor(opts: {
    client: Pick<CoinalyzeClient, "predictedFundingRateHistory" | "openInterestUsdHistory">;
    store: Pick<SnapshotStore, "history" | "addBackfill">;
    intervalMs: number;
    now?: () => number;
  }) {
    this.client = opts.client;
    this.store = opts.store;
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Runs after `store.add(snaps)`; only the first call does anything. Every coin whose new point is more than
   * GAP_INTERVALS intervals after its previous one gets the last BACKFILL_MAX_MS of that gap rebuilt, in one batch
   * of API calls for all coins: one per market reporting a rate and one per listed market. The batch delays the next
   * polls, so the rebuilt range runs until the rate history arrived, and later polls are never checked: their delayed
   * spacing would trigger another backfill. Never throws; a failed backfill leaves the gap.
   */
  async fill(snaps: Snapshot[]): Promise<void> {
    if (this.checked) return;
    this.checked = true;
    const history = this.store.history();
    const gaps = snaps.flatMap((snap) => {
      const previous = history.filter((p) => p.symbol === snap.symbol && p.timestamp < snap.timestamp).at(-1);
      if (previous === undefined || snap.timestamp - previous.timestamp <= GAP_INTERVALS * this.intervalMs) return [];
      return [{ snap, from: Math.max(previous.timestamp, snap.timestamp - BACKFILL_MAX_MS) }];
    });
    if (gaps.length === 0) return;
    const listed = gaps.flatMap((g) => g.snap.components.filter((c) => c.symbol !== null));
    const rateSymbols = listed.filter((c) => c.status === "used" || c.status === "stale").map((c) => c.symbol!);
    const oiSymbols = listed.map((c) => c.symbol!);
    const start = Math.min(...gaps.map((g) => g.from));
    const ahead = Math.ceil(this.now() / 1000) + REQUEST_AHEAD_S;
    log.info(`filling ${gaps.length} gap(s) from 1-minute history (${rateSymbols.length + oiSymbols.length} API calls)`);
    try {
      const series = (list: CandleSeries[]) => new Map(list.map((s) => [s.symbol, s.history]));
      const rates = series(await this.client.predictedFundingRateHistory(rateSymbols, Math.floor((start - STALE_AFTER_MS) / 1000), ahead));
      const to = this.now();
      const openInterest = series(
        await this.client.openInterestUsdHistory(oiSymbols, Math.floor((start - OI_HISTORY_MAX_AGE_MS) / 1000), ahead),
      );
      const stepMs = Math.max(MINUTE_MS, Math.round(this.intervalMs / MINUTE_MS) * MINUTE_MS);
      for (const g of gaps) {
        const points = rebuildPoints({ coin: g.snap.symbol, components: g.snap.components, rates, openInterest, from: g.from, to, stepMs });
        this.store.addBackfill(points);
        log.info(`${g.snap.symbol}: backfilled ${points.length} points between ${new Date(g.from).toISOString()} and ${new Date(to).toISOString()}`);
      }
    } catch (e) {
      log.warn(`backfill failed, the gap stays: ${errorMessage(e)}`);
    }
  }
}
