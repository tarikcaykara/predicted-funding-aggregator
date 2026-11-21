/**
 * The stablecoin-margined venues coinalyze.net lists in the "Current / Predicted" table of every coin's
 * funding-rate page (BTC, ETH and SOL list the same ten; checked 2026-10-14). Labels match the page so
 * `bun run calibrate` can detect listing changes.
 *
 * A venue resolves to the one perpetual on `exchange` with `quote` for the coin (Coinalyze exchange codes).
 * `ratePeriodHours` is the period the API's predicted rate refers to; measured by calibration.
 */
export interface Venue {
  label: string;
  exchange: string;
  quote: string;
  ratePeriodHours: 1 | 8;
}

export const VENUES: readonly Venue[] = [
  { label: "BINANCE USDC", exchange: "A", quote: "USDC", ratePeriodHours: 8 },
  { label: "BINANCE USDT", exchange: "A", quote: "USDT", ratePeriodHours: 8 },
  { label: "BYBIT USDC", exchange: "6", quote: "USDC", ratePeriodHours: 8 },
  { label: "BYBIT USDT", exchange: "6", quote: "USDT", ratePeriodHours: 8 },
  { label: "DERIBIT", exchange: "2", quote: "USDC", ratePeriodHours: 8 },
  { label: "HUOBI", exchange: "4", quote: "USDT", ratePeriodHours: 8 },
  { label: "HYPERLIQUID", exchange: "H", quote: "USD", ratePeriodHours: 1 },
  { label: "KRAKEN", exchange: "K", quote: "USD", ratePeriodHours: 1 },
  { label: "OKX", exchange: "3", quote: "USDT", ratePeriodHours: 8 },
  { label: "WOO X", exchange: "W", quote: "USDT", ratePeriodHours: 8 },
];

/** Predicted rates older than this are excluded (live venues update about every minute). */
export const STALE_AFTER_MS = 15 * 60 * 1000;
