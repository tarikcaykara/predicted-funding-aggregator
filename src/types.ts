import type { CoinSymbol } from "./coins.ts";

/**
 * - used: fresh predicted rate, part of both averages
 * - stale: predicted rate older than STALE_AFTER_MS
 * - no_rate: the API reports no predicted rate (e.g. Deribit, Huobi, OKX)
 * - unlisted: the venue has no matching perpetual for this coin
 */
export type ComponentStatus = "used" | "stale" | "no_rate" | "unlisted";

/** One venue's contribution to a coin's aggregate. Rates are % per period; `rate_8h` is normalized. */
export interface MarketComponent {
  venue: string;
  symbol: string | null;
  predicted_rate: number | null;
  rate_period_hours: number;
  rate_8h: number | null;
  oi_usd: number | null;
  updated_at: number | null;
  status: ComponentStatus;
}

/** Wire, store and `funding_rate.json` format. v1 fields: aggregated_predicted_funding_rate, coin, timestamp. */
export interface Snapshot {
  type: "snapshot";
  symbol: CoinSymbol;
  /** Coinalyze slug ("ethereum"); kept from the v1 payload. */
  coin: string;
  timestamp: number;
  aggregated_predicted_funding_rate: number;
  oi_weighted_predicted_funding_rate: number | null;
  /** Number of `used` components. */
  markets: number;
  /**
   * Sum of `oi_usd` over the listed components (every status but `unlisted`); a market whose OI the API
   * omits counts as 0. `null` until every listed market's OI has been fetched once.
   */
  open_interest_usd: number | null;
  unit: "percent_per_8h";
  components: MarketComponent[];
}

/** A snapshot without its per-market breakdown, as kept in history. */
export type HistoryPoint = Omit<Snapshot, "components">;

export interface Source {
  readonly name: string;
  readonly intervalMs: number;
  /** Returns snapshots of the coins that produced a value; throws only when none did. */
  poll(): Promise<Snapshot[]>;
}

export interface SourceStatus {
  intervalMs: number;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}
