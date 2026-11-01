import { expect, test } from "bun:test";
import type { FutureMarket, ValuePoint } from "../src/coinalyze/client.ts";
import { FundingSource, OI_REFRESH_MS, OI_SEED_MAX_AGE_MS, STALE_AFTER_MS } from "../src/funding/source.ts";
import type { Snapshot } from "../src/types.ts";

const T0 = 1_800_000_000_000;

const perp = (symbol: string, exchange: string, quote: string, extra: Partial<FutureMarket> = {}): FutureMarket => ({
  symbol,
  exchange,
  symbol_on_exchange: symbol,
  base_asset: "ETH",
  quote_asset: quote,
  is_perpetual: true,
  margined: "STABLE",
  ...extra,
});

const MARKETS: FutureMarket[] = [
  perp("ETHUSDT_PERP.A", "A", "USDT"), // BINANCE USDT
  perp("ETH.H", "H", "USD"), // HYPERLIQUID, hourly rate
  perp("pf_ethusd.K", "K", "USD"), // KRAKEN, hourly rate
  perp("ETH_USDC-PERPETUAL.2", "2", "USDC"), // DERIBIT, no predicted rate
  // Not in the venue list:
  perp("7.O", "O", "USD"), // Polymarket
  perp("ETHU_PERP.A", "A", "U"), // Binance, exotic quote
  perp("ETHUSD_PERP.A", "A", "USD", { margined: "COIN" }), // coin-margined
  perp("ETHUSDT_260327.A", "A", "USDT", { is_perpetual: false }), // dated future
];

const fakeClient = (clock: { now: number }) => {
  const calls = { futureMarkets: 0, openInterest: 0, oiBatches: [] as string[][], oiFails: false, requested: [] as string[] };
  const client = {
    futureMarkets: async () => {
      calls.futureMarkets++;
      return MARKETS;
    },
    predictedFundingRate: async (symbols: string[]): Promise<ValuePoint[]> => {
      calls.requested = symbols;
      const rates: ValuePoint[] = [
        { symbol: "ETHUSDT_PERP.A", value: 0.02, update: clock.now - 30_000 },
        { symbol: "ETH.H", value: 0.00125, update: clock.now - 30_000 },
        { symbol: "pf_ethusd.K", value: 0.5, update: clock.now - STALE_AFTER_MS - 1 },
        // Deribit is omitted, as the API does for venues without a predicted rate.
      ];
      return rates.filter((r) => symbols.includes(r.symbol));
    },
    openInterestUsd: async (symbols: string[]): Promise<ValuePoint[]> => {
      calls.openInterest++;
      calls.oiBatches.push(symbols);
      if (calls.oiFails) throw new Error("oi down");
      const oi: ValuePoint[] = [
        { symbol: "ETHUSDT_PERP.A", value: 300, update: clock.now },
        { symbol: "ETH.H", value: 100, update: clock.now },
        { symbol: "pf_ethusd.K", value: 1e12, update: clock.now },
      ];
      return oi.filter((r) => symbols.includes(r.symbol));
    },
  };
  return { client, calls };
};

test("aggregates fresh venue rates only, normalized to 8h, with a per-venue breakdown", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now });

  const [eth] = await source.poll();

  expect(calls.requested.sort()).toEqual(["ETH.H", "ETHUSDT_PERP.A", "ETH_USDC-PERPETUAL.2", "pf_ethusd.K"]);
  // Binance 0.02 (OI 300) and Hyperliquid 0.00125/h → 0.01/8h (OI 100); stale Kraken excluded.
  expect(eth!.aggregated_predicted_funding_rate).toBeCloseTo(0.015, 12);
  expect(eth!.oi_weighted_predicted_funding_rate).toBeCloseTo(0.0175, 12);
  expect(eth!.markets).toBe(2);

  const byVenue = Object.fromEntries(eth!.components.map((c) => [c.venue, c]));
  expect(byVenue["BINANCE USDT"]!.status).toBe("used");
  expect(byVenue["HYPERLIQUID"]!).toMatchObject({ status: "used", predicted_rate: 0.00125, rate_8h: 0.01 });
  expect(byVenue["KRAKEN"]!.status).toBe("stale");
  expect(byVenue["DERIBIT"]!).toMatchObject({ status: "no_rate", symbol: "ETH_USDC-PERPETUAL.2", rate_8h: null });
  expect(byVenue["BINANCE USDC"]!).toMatchObject({ status: "unlisted", symbol: null });
  expect(eth!.components).toHaveLength(10);
});

test("market list is cached for a day", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now });

  await source.poll();
  clock.now += 60000;
  await source.poll();
  clock.now += 60000;
  await source.poll();
  expect(calls.futureMarkets).toBe(1);
});

test("open interest is refreshed a few markets per cycle, oldest first; OI-weighted stays null until every used venue has OI", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  const source = new FundingSource({
    client,
    coins: ["ETH"],
    intervalMs: 60000,
    now: () => clock.now,
    openInterestPerCycle: 2,
  });

  const [first] = await source.poll();
  expect(calls.oiBatches).toEqual([["ETHUSDT_PERP.A", "ETH_USDC-PERPETUAL.2"]]);
  expect(first!.aggregated_predicted_funding_rate).toBeCloseTo(0.015, 12);
  expect(first!.oi_weighted_predicted_funding_rate).toBeNull();

  clock.now += 60000;
  const [second] = await source.poll();
  expect(calls.oiBatches[1]).toEqual(["ETH.H", "pf_ethusd.K"]);
  expect(second!.oi_weighted_predicted_funding_rate).toBeCloseTo(0.0175, 12);

  clock.now += 60000;
  await source.poll();
  expect(calls.openInterest).toBe(2);

  // Poll-1 entries (fetched at T0) are now exactly OI_REFRESH_MS old and due; poll-2 entries (T0 + 60 s) are not.
  clock.now = T0 + OI_REFRESH_MS;
  await source.poll();
  expect(calls.oiBatches[2]).toEqual(["ETHUSDT_PERP.A", "ETH_USDC-PERPETUAL.2"]);
  expect(calls.openInterest).toBe(3);
});

test("an open-interest failure still publishes AVG with OI-weighted null", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  calls.oiFails = true;
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now });

  const [eth] = await source.poll();
  expect(eth!.aggregated_predicted_funding_rate).toBeCloseTo(0.015, 12);
  expect(eth!.oi_weighted_predicted_funding_rate).toBeNull();
});

const seedSnapshot = (timestamp: number): Snapshot => ({
  type: "snapshot",
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: 0.015,
  oi_weighted_predicted_funding_rate: 0.0175,
  markets: 2,
  unit: "percent_per_8h",
  components: [
    ["BINANCE USDT", "ETHUSDT_PERP.A", 300],
    ["HYPERLIQUID", "ETH.H", 100],
  ].map(([venue, symbol, oi]) => ({
    venue: venue as string,
    symbol: symbol as string,
    predicted_rate: null,
    rate_period_hours: 1,
    rate_8h: null,
    oi_usd: oi as number,
    updated_at: null,
    status: "used" as const,
  })),
});

test("seeded open interest gives OI-weighted on the first poll; seeds older than OI_SEED_MAX_AGE_MS or dated in the future are ignored", async () => {
  const clock = { now: T0 };
  const { client, calls } = fakeClient(clock);
  const seeded = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now, openInterestPerCycle: 0 });
  seeded.seedOpenInterest([seedSnapshot(T0 - 60_000)]);
  const [eth] = await seeded.poll();
  expect(eth!.oi_weighted_predicted_funding_rate).toBeCloseTo(0.0175, 12);
  expect(calls.openInterest).toBe(0);

  const old = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now, openInterestPerCycle: 0 });
  old.seedOpenInterest([seedSnapshot(T0 - OI_SEED_MAX_AGE_MS - 1)]);
  const [ethOld] = await old.poll();
  expect(ethOld!.oi_weighted_predicted_funding_rate).toBeNull();

  const future = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now, openInterestPerCycle: 0 });
  future.seedOpenInterest([seedSnapshot(T0 + 60_000)]);
  const [ethFuture] = await future.poll();
  expect(ethFuture!.oi_weighted_predicted_funding_rate).toBeNull();
});

test("throws when no coin has a fresh rate", async () => {
  const clock = { now: T0 };
  const { client } = fakeClient(clock);
  const source = new FundingSource({ client, coins: ["ETH"], intervalMs: 60000, now: () => clock.now + STALE_AFTER_MS + 60_000 });
  await expect(source.poll()).rejects.toThrow("no coin produced a value");
});
