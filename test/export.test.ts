import { expect, test } from "bun:test";
import { exportBody, parseExportQuery } from "../src/export.ts";
import type { HistoryPoint } from "../src/types.ts";

const parse = (query: string) => parseExportQuery(new URLSearchParams(query));

test("symbol is required and case-insensitive; the range defaults to everything, the format to CSV", () => {
  expect(parse("symbol=eth")).toEqual({ symbol: "ETH", from: 0, to: Number.MAX_SAFE_INTEGER, format: "csv" });
  expect(parse("symbol=BTC&from=1000&to=2000&format=json")).toEqual({ symbol: "BTC", from: 1000, to: 2000, format: "json" });
});

test.each([
  ["", 'missing "symbol" (supported: BTC, ETH, SOL)'],
  ["symbol=DOGE", 'unknown symbol "DOGE" (supported: BTC, ETH, SOL)'],
  ["symbol=ETH&from=-1", '"from" must be a whole number of milliseconds since the epoch'],
  ["symbol=ETH&to=2026-11-01", '"to" must be a whole number of milliseconds since the epoch'],
  ["symbol=ETH&from=99999999999999999999", '"from" must be a whole number of milliseconds since the epoch'],
  ["symbol=ETH&from=2000&to=2000", '"from" must be less than "to"'],
  ["symbol=ETH&format=xml", 'unknown format "xml" (csv or json)'],
])("rejects %p", (query, error) => {
  expect(parse(query)).toEqual({ error });
});

const point = (timestamp: number, oiWeighted: number | null, openInterest: number | null): HistoryPoint => ({
  type: "snapshot",
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: 0.01,
  oi_weighted_predicted_funding_rate: oiWeighted,
  markets: 7,
  open_interest_usd: openInterest,
  unit: "percent_per_8h",
});

test("the body joins pages, empty ones included, into one CSV or one JSON array", async () => {
  const points = [point(1000, null, null), point(2000, 0.012, 12_345_678_901.5), point(3000, -0.5, 1e9)];
  const pages = () => [[points[0]!], [], [points[1]!, points[2]!], []].values();

  expect(await new Response(exportBody(pages(), "json")).json()).toEqual(points);
  expect(await new Response(exportBody(pages(), "csv")).text()).toBe(
    "timestamp,time,symbol,aggregated_predicted_funding_rate,oi_weighted_predicted_funding_rate,markets,open_interest_usd\n" +
      "1000,1970-01-01T00:00:01.000Z,ETH,0.01,,7,\n" +
      "2000,1970-01-01T00:00:02.000Z,ETH,0.01,0.012,7,12345678901.5\n" +
      "3000,1970-01-01T00:00:03.000Z,ETH,0.01,-0.5,7,1000000000\n",
  );
  expect(await new Response(exportBody([].values(), "json")).json()).toEqual([]);
});
