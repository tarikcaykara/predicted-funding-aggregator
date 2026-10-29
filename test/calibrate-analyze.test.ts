import { expect, test } from "bun:test";
import { analyzeCoin, bestLag, historyFit, minuteAverage, type Sample } from "../scripts/calibrate/analyze.ts";
import type { PageVenue } from "../scripts/calibrate/chart-page.ts";
import { VENUES } from "../src/funding/universe.ts";

const pageSample = (page: PageVenue[]): Sample => ({ at: 0, coins: { BTC: { chart: null, page, api: null } } });

test("analyzeCoin reports the listing as unknown when no sample read the venue table", () => {
  expect(analyzeCoin([pageSample([]), pageSample([])], "BTC", 0, null).listing).toBeNull();
});

test("analyzeCoin takes listing drift from the samples that read the venue table", () => {
  const page = [...VENUES.slice(1).map((v) => v.label), "LIGHTER"].map((label) => ({ label, current: null, predicted: null }));
  expect(analyzeCoin([pageSample([]), pageSample(page)], "BTC", 0, null).listing).toEqual({
    missingOnPage: [VENUES[0]!.label],
    extraOnPage: ["LIGHTER"],
  });
});

test("bestLag finds how many samples the reference trails the series", () => {
  const series = [1, 2, 3, 4, 5, 6, 7, 8];
  const reference = [null, null, 1, 2, 3, 4, 5, 6]; // series delayed by 2 samples
  const fit = bestLag(reference, series, 4);
  expect(fit.best).toMatchObject({ lag: 2, mad: 0, n: 6 });
  expect(fit.atZero!.mad).toBe(2);
});

test("minuteAverage normalizes hourly venues to 8h and carries a close for at most 15 minutes", () => {
  const avg = minuteAverage(
    [
      { ratePeriodHours: 1, candles: [{ t: 0, c: 0.00125 }] }, // → 0.01 per 8h, only at minute 0
      { ratePeriodHours: 8, candles: Array.from({ length: 21 }, (_, m) => ({ t: m * 60, c: 0.02 })) },
    ],
    0,
    20,
  );
  expect(avg.get(15)).toBeCloseTo(0.015, 12);
  expect(avg.get(16)).toBeCloseTo(0.02, 12);
});

test("historyFit compares the chart with a trailing SMA ending `lag` minutes before each sample", () => {
  const avgByMinute = new Map<number, number>(Array.from({ length: 30 }, (_, m) => [m, m] as [number, number]));
  // Sample at minute 25; lag 5 → window minutes 11..20 → SMA 15.5.
  const chart = [{ at: 25 * 60000 + 30000, value: 15.5 }];
  expect(historyFit(chart, avgByMinute, 5, 10)).toMatchObject({ lag: 5, mad: 0, n: 1 });
  expect(historyFit(chart, avgByMinute, 0, 1)!.mad).toBe(9.5);
});
