import type { CoinalyzeClient, FutureMarket } from "../coinalyze/client.ts";
import { COIN_REGISTRY, type CoinSymbol } from "../coins.ts";
import { createLogger, errorMessage } from "../log.ts";
import type { MarketComponent, Snapshot, Source } from "../types.ts";
import { aggregate } from "./aggregate.ts";
import { VENUES, type Venue } from "./universe.ts";

const log = createLogger("funding");

const MARKET_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Max age of a market's open interest before it is refetched. */
export const OI_REFRESH_MS = 600000;
/** Persisted snapshots older than this, or dated in the future, are not used to seed open interest. */
export const OI_SEED_MAX_AGE_MS = 30 * 60 * 1000;
/** API calls kept free per cycle. */
const CALL_MARGIN = 2;
/** Predicted rates older than this are excluded (live venues update about every minute). */
export const STALE_AFTER_MS = 15 * 60 * 1000;
const API_CALLS_PER_MIN = 40;

type Client = Pick<CoinalyzeClient, "futureMarkets" | "predictedFundingRate" | "openInterestUsd">;

interface ResolvedVenue {
  venue: Venue;
  symbol: string | null;
}

/** Polls Coinalyze for every venue in VENUES and aggregates per coin. */
export class FundingSource implements Source {
  readonly name = "funding";
  readonly intervalMs: number;
  private readonly client: Client;
  private readonly coins: CoinSymbol[];
  private readonly now: () => number;
  private venuesByCoin = new Map<CoinSymbol, ResolvedVenue[]>();
  private marketsAt: number | null = null;
  private oiCache = new Map<string, { value: number | null; fetchedAt: number }>();
  private readonly openInterestPerCycle: number | undefined;

  constructor(opts: {
    client: Client;
    coins: CoinSymbol[];
    intervalMs: number;
    now?: () => number;
    openInterestPerCycle?: number;
  }) {
    this.openInterestPerCycle = opts.openInterestPerCycle;
    this.client = opts.client;
    this.coins = opts.coins;
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? Date.now;
  }

  async poll(): Promise<Snapshot[]> {
    const marketsCalls = await this.resolveVenues();
    const symbols = [...this.venuesByCoin.values()].flat().flatMap((v) => (v.symbol === null ? [] : [v.symbol]));

    const rates = new Map<string, { value: number; update: number }>();
    for (const p of await this.client.predictedFundingRate(symbols)) rates.set(p.symbol, p);

    try {
      await this.refreshOpenInterest(symbols, marketsCalls);
    } catch (e) {
      log.warn(`open interest refresh failed: ${errorMessage(e)}; keeping cached values`);
    }

    const now = this.now();
    const snapshots: Snapshot[] = [];
    for (const [coin, venues] of this.venuesByCoin) {
      const components = venues.map(({ venue, symbol }) => this.component(venue, symbol, rates, now));
      const used = components.filter((c) => c.status === "used");
      const result = aggregate(used.map((c) => ({ rate: c.rate_8h, oiUsd: c.oi_usd })));
      const oiComplete = used.every((c) => c.symbol !== null && this.oiCache.has(c.symbol));
      if (result.avg === null) {
        log.warn(`${coin}: no venue has a fresh predicted rate`);
        continue;
      }
      snapshots.push({
        type: "snapshot",
        symbol: coin,
        coin: COIN_REGISTRY[coin].slug,
        timestamp: now,
        aggregated_predicted_funding_rate: result.avg,
        oi_weighted_predicted_funding_rate: oiComplete ? result.oiWeighted : null,
        markets: result.count,
        unit: "percent_per_8h",
        components,
      });
    }
    if (snapshots.length === 0) throw new Error("no coin produced a value");
    log.info(
      snapshots
        .map((s) => `${s.symbol} avg=${s.aggregated_predicted_funding_rate.toFixed(4)}% (${s.markets}/${VENUES.length})`)
        .join(", "),
    );
    return snapshots;
  }

  private component(
    venue: Venue,
    symbol: string | null,
    rates: Map<string, { value: number; update: number }>,
    now: number,
  ): MarketComponent {
    const point = symbol === null ? undefined : rates.get(symbol);
    const value = point !== undefined && Number.isFinite(point.value) ? point.value : null;
    const status =
      symbol === null
        ? "unlisted"
        : value === null || point === undefined
          ? "no_rate"
          : now - point.update > STALE_AFTER_MS
            ? "stale"
            : "used";
    return {
      venue: venue.label,
      symbol,
      predicted_rate: value,
      rate_period_hours: venue.ratePeriodHours,
      rate_8h: value === null ? null : (value * 8) / venue.ratePeriodHours,
      oi_usd: symbol === null ? null : (this.oiCache.get(symbol)?.value ?? null),
      updated_at: point?.update ?? null,
      status,
    };
  }

  /** Returns the number of /future-markets calls made (0 or 1). */
  private async resolveVenues(): Promise<number> {
    if (this.marketsAt !== null && this.now() - this.marketsAt <= MARKET_REFRESH_MS) return 0;
    const perpetuals = (await this.client.futureMarkets()).filter(
      (m) => m.is_perpetual === true && m.margined === "STABLE",
    );
    const resolved = new Map<CoinSymbol, ResolvedVenue[]>();
    for (const coin of this.coins) {
      resolved.set(
        coin,
        VENUES.map((venue) => ({ venue, symbol: this.matchVenue(coin, venue, perpetuals) })),
      );
    }
    this.venuesByCoin = resolved;
    this.marketsAt = this.now();

    const n = [...resolved.values()].flat().filter((v) => v.symbol !== null).length;
    const callsPerMin = (n * 60000) / this.intervalMs + (n * 60000) / OI_REFRESH_MS;
    log.info(`resolved ${n} markets across ${this.coins.length} coin(s), ~${callsPerMin.toFixed(1)} API calls/min`);
    if (callsPerMin > API_CALLS_PER_MIN) {
      log.warn(
        `estimated ${callsPerMin.toFixed(1)} calls/min exceeds the ${API_CALLS_PER_MIN}/min API limit; cycles will be throttled`,
      );
    }
    return 1;
  }

  private matchVenue(coin: CoinSymbol, venue: Venue, perpetuals: FutureMarket[]): string | null {
    const matches = perpetuals.filter(
      (m) => m.base_asset === coin && m.exchange === venue.exchange && m.quote_asset === venue.quote,
    );
    if (matches.length === 1) return matches[0]!.symbol;
    if (matches.length > 1) {
      log.warn(`${coin} ${venue.label}: ${matches.length} matching perpetuals (${matches.map((m) => m.symbol).join(", ")}); skipped`);
    }
    return null;
  }

  private async refreshOpenInterest(symbols: string[], marketsCalls: number): Promise<void> {
    const now = this.now();
    const n = symbols.length;
    const slots = this.openInterestPerCycle ?? this.defaultSlots(n, marketsCalls);
    const due = symbols
      .filter((s) => {
        const e = this.oiCache.get(s);
        return e === undefined || now - e.fetchedAt >= OI_REFRESH_MS;
      })
      .sort((a, b) => (this.oiCache.get(a)?.fetchedAt ?? 0) - (this.oiCache.get(b)?.fetchedAt ?? 0));
    const batch = due.slice(0, slots);
    if (batch.length === 0) return;
    const returned = new Map<string, number>();
    for (const p of await this.client.openInterestUsd(batch)) returned.set(p.symbol, p.value);
    const fetchedAt = this.now();
    for (const s of batch) this.oiCache.set(s, { value: returned.get(s) ?? null, fetchedAt });
  }

  private defaultSlots(n: number, marketsCalls: number): number {
    const steady = Math.ceil((n * this.intervalMs) / OI_REFRESH_MS);
    const cap = Math.min(API_CALLS_PER_MIN, (API_CALLS_PER_MIN * this.intervalMs) / 60000) - CALL_MARGIN;
    return Math.max(steady, Math.floor(cap - n - marketsCalls));
  }

  /** Seeds the OI cache from persisted snapshots; seeds are due immediately so real fetches replace them first. */
  seedOpenInterest(snapshots: Snapshot[]): void {
    let count = 0;
    for (const s of snapshots) {
      const age = this.now() - s.timestamp;
      if (age < 0 || age > OI_SEED_MAX_AGE_MS) continue;
      for (const c of s.components) {
        if (c.symbol === null || c.oi_usd === null || !Number.isFinite(c.oi_usd) || this.oiCache.has(c.symbol)) continue;
        this.oiCache.set(c.symbol, { value: c.oi_usd, fetchedAt: s.timestamp - OI_REFRESH_MS });
        count++;
      }
    }
    if (count > 0) log.info(`seeded open interest for ${count} markets from persisted snapshots`);
  }
}
