import type { CandleSeries, FutureMarket, ValuePoint } from "../src/coinalyze/client.ts";
import type { CoinSymbol } from "../src/coins.ts";
import { VENUES, type Venue } from "../src/funding/universe.ts";

export const FAKE_API_KEY = "e2e-key";
export const RATE_8H = 0.01; // every venue's rate per 8h, so AVG = OI-weighted = 0.01
export const OI_USD = 1_000_000;
// Deribit, Huobi and OKX: the real API omits their predicted rates, so they become `no_rate`.
const NO_RATE_EXCHANGES = ["2", "4", "3"];

export interface FakeCoinalyze {
  readonly url: string;
  /** Pathname of every request received, in order. */
  readonly requests: string[];
  /** Status of every /open-interest response; anything but 200 returns an empty body. */
  oiStatus: number;
  stop(): void;
}

/** A loopback Coinalyze API listing one stablecoin perpetual per coin and VENUES entry. */
export const startFakeCoinalyze = (coins: CoinSymbol[] = ["BTC"]): FakeCoinalyze => {
  const venueBySymbol = new Map<string, Venue>();
  const markets: FutureMarket[] = coins.flatMap((coin) =>
    VENUES.map((v) => {
      const symbol = `${coin}${v.quote}_PERP.${v.exchange}`;
      venueBySymbol.set(symbol, v);
      return {
        symbol,
        exchange: v.exchange,
        symbol_on_exchange: `${coin}${v.quote}`,
        base_asset: coin,
        quote_asset: v.quote,
        is_perpetual: true,
        margined: "STABLE",
      };
    }),
  );

  const requests: string[] = [];
  const fake = {
    url: "",
    requests,
    oiStatus: 200,
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (req.headers.get("api_key") !== FAKE_API_KEY) return new Response("", { status: 401 });
      const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter((s) => venueBySymbol.has(s));
      switch (url.pathname) {
        case "/v1/future-markets":
          return Response.json(markets);
        case "/v1/predicted-funding-rate":
          return Response.json(
            symbols.flatMap((symbol): ValuePoint[] => {
              const v = venueBySymbol.get(symbol)!;
              if (NO_RATE_EXCHANGES.includes(v.exchange)) return [];
              return [{ symbol, value: (RATE_8H * v.ratePeriodHours) / 8, update: Date.now() }];
            }),
          );
        case "/v1/open-interest":
          if (fake.oiStatus !== 200) return new Response("", { status: fake.oiStatus });
          return Response.json(symbols.map((symbol): ValuePoint => ({ symbol, value: OI_USD, update: Date.now() })));
        case "/v1/predicted-funding-rate-history":
        case "/v1/open-interest-history": {
          // One flat bar per minute from `from` up to the current minute, as the real API has no future bars.
          const rate = url.pathname === "/v1/predicted-funding-rate-history";
          const first = Math.ceil(Number(url.searchParams.get("from")) / 60) * 60;
          const last = Math.min(Number(url.searchParams.get("to")), Math.floor(Date.now() / 1000));
          return Response.json(
            symbols.flatMap((symbol): CandleSeries[] => {
              const v = venueBySymbol.get(symbol)!;
              if (rate && NO_RATE_EXCHANGES.includes(v.exchange)) return [];
              const c = rate ? (RATE_8H * v.ratePeriodHours) / 8 : OI_USD;
              const history = [];
              for (let t = first; t <= last; t += 60) history.push({ t, o: c, h: c, l: c, c });
              return [{ symbol, history }];
            }),
          );
        }
        default:
          return new Response("", { status: 404 });
      }
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/v1`;
  return fake;
};
