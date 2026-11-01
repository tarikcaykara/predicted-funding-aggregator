import { createLogger } from "../log.ts";
import type { RateLimiter } from "./rate-limiter.ts";

const log = createLogger("coinalyze");

export interface FutureMarket {
  symbol: string;
  exchange: string;
  symbol_on_exchange: string;
  base_asset: string;
  quote_asset: string;
  is_perpetual: boolean;
  margined: string;
}

export interface ValuePoint {
  symbol: string;
  value: number;
  update: number;
}

export interface CandleSeries {
  symbol: string;
  /** `t` is the bar's open time in UNIX seconds; `c` its close. */
  history: { t: number; o: number; h: number; l: number; c: number }[];
}

export class CoinalyzeApiError extends Error {
  override name = "CoinalyzeApiError";
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const MAX_SYMBOLS_PER_REQUEST = 20;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_S = 60;
const REQUEST_TIMEOUT_MS = 15000;

export class CoinalyzeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly limiter: Pick<RateLimiter, "acquire">;
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<unknown>;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    limiter: Pick<RateLimiter, "acquire">;
    fetch?: Fetch;
    sleep?: (ms: number) => Promise<unknown>;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.coinalyze.net/v1";
    this.limiter = opts.limiter;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? Bun.sleep;
  }

  futureMarkets(): Promise<FutureMarket[]> {
    return this.request<FutureMarket[]>("/future-markets");
  }

  predictedFundingRate(symbols: string[]): Promise<ValuePoint[]> {
    return this.perSymbol("/predicted-funding-rate", symbols, {});
  }

  openInterestUsd(symbols: string[]): Promise<ValuePoint[]> {
    return this.perSymbol("/open-interest", symbols, { convert_to_usd: "true" });
  }

  /** 1-minute OHLC of the predicted rate; `from`/`to` are UNIX seconds (inclusive). */
  predictedFundingRateHistory(symbols: string[], from: number, to: number): Promise<CandleSeries[]> {
    return this.perSymbol("/predicted-funding-rate-history", symbols, {
      interval: "1min",
      from: String(from),
      to: String(to),
    });
  }

  /** Each symbol costs one API call; at most 20 symbols fit in one request. */
  private async perSymbol<T>(path: string, symbols: string[], params: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_REQUEST) {
      const chunk = symbols.slice(i, i + MAX_SYMBOLS_PER_REQUEST);
      results.push(...(await this.request<T[]>(path, { symbols: chunk.join(","), ...params }, chunk.length)));
    }
    return results;
  }

  /** `cost` is the number of API calls the request counts as. Every attempt goes through the limiter. */
  private async request<T>(path: string, params: Record<string, string> = {}, cost = 1): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    for (let attempt = 1; ; attempt++) {
      const refund = await this.limiter.acquire(cost);
      const res = await this.fetch(url, {
        headers: { api_key: this.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 401) throw new CoinalyzeApiError("invalid COINALYZE_API_KEY (401)");
      if (res.status === 429) {
        // A rejected request does not use the server's budget; the retry is counted when it is sent.
        refund();
        if (attempt >= MAX_ATTEMPTS) {
          throw new CoinalyzeApiError(`rate limited (429) after ${MAX_ATTEMPTS} attempts`);
        }
        const header = res.headers.get("retry-after") ?? "";
        const numeric = /^\d+(\.\d+)?$/.test(header);
        const seconds = numeric ? Number(header) : DEFAULT_RETRY_AFTER_S;
        log.warn(
          `rate limited (429) on ${path}, attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${seconds}s` +
            (numeric ? "" : " (default: Retry-After missing or not in seconds)"),
        );
        await this.sleep(seconds * 1000);
        continue;
      }
      if (!res.ok) throw new CoinalyzeApiError(`HTTP ${res.status} for ${path}`);
      return (await res.json()) as T;
    }
  }
}
