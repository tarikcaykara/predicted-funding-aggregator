import { expect, test } from "bun:test";
import { runSourceLoop } from "../src/loop.ts";
import type { Snapshot, Source, SourceStatus } from "../src/types.ts";

const snapshot: Snapshot = {
  type: "snapshot",
  symbol: "ETH",
  coin: "ethereum",
  timestamp: 1,
  aggregated_predicted_funding_rate: 0.01,
  oi_weighted_predicted_funding_rate: null,
  markets: 3,
  open_interest_usd: null,
  unit: "percent_per_8h",
  components: [],
};

test("failures (including the first poll) are retried until a success resets the counter", async () => {
  const controller = new AbortController();
  const status: SourceStatus = {
    intervalMs: 1000,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  const failuresSeen: number[] = [];
  let polls = 0;
  let clock = 0;
  const source: Source = {
    name: "funding",
    intervalMs: 1000,
    poll: async () => {
      polls++;
      failuresSeen.push(status.consecutiveFailures);
      if (polls <= 2) throw new Error(`boom ${polls}`);
      return [snapshot];
    },
  };
  const added: Snapshot[][] = [];
  const sleeps: number[] = [];

  await runSourceLoop(source, { add: async (s) => void added.push(s) }, status, controller.signal, {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      if (polls === 3) controller.abort();
    },
  });

  expect(polls).toBe(3);
  expect(failuresSeen).toEqual([0, 1, 2]);
  expect(status.consecutiveFailures).toBe(0);
  expect(status.lastError).toBeNull();
  expect(status.lastSuccessAt).toBe(2000);
  expect(added).toEqual([[snapshot]]);
  expect(sleeps).toEqual([1000, 1000, 1000]);
});
