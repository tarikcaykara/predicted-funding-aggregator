import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = { AUTH_TOKEN: "s".repeat(32), COINALYZE_API_KEY: "key" };

describe("loadConfig", () => {
  test("requires COINALYZE_API_KEY and a non-blank AUTH_TOKEN", () => {
    expect(() => loadConfig({ AUTH_TOKEN: "secret" })).toThrow("Missing required env var COINALYZE_API_KEY");
    expect(() => loadConfig({ COINALYZE_API_KEY: "key", AUTH_TOKEN: "  " })).toThrow("Missing required env var AUTH_TOKEN");
  });

  test("COINS is trimmed, uppercased, deduplicated and order-preserving", () => {
    expect(loadConfig({ ...base, COINS: "eth, btc,ETH" }).coins).toEqual(["ETH", "BTC"]);
  });

  test("rejects unknown and empty coin lists", () => {
    expect(() => loadConfig({ ...base, COINS: "DOGE" })).toThrow(
      'Invalid COINS entry "DOGE" (supported: BTC, ETH, SOL)',
    );
    expect(() => loadConfig({ ...base, COINS: "" })).toThrow('Invalid COINS entry ""');
  });

  test.each(["abc", "0", "1.5", "-5"])("rejects INTERVAL_MS=%p", (raw) => {
    expect(() => loadConfig({ ...base, INTERVAL_MS: raw })).toThrow(`Invalid INTERVAL_MS: "${raw}"`);
  });

  test("COINALYZE_BASE_URL defaults to the client's URL and is trimmed without trailing slashes", () => {
    expect(loadConfig(base).coinalyzeBaseUrl).toBeUndefined();
    expect(loadConfig({ ...base, COINALYZE_BASE_URL: " http://127.0.0.1:9/v1/ " }).coinalyzeBaseUrl).toBe(
      "http://127.0.0.1:9/v1",
    );
  });

  test.each(["not a url", "ftp://x/v1"])("rejects COINALYZE_BASE_URL=%p", (raw) => {
    expect(() => loadConfig({ ...base, COINALYZE_BASE_URL: raw })).toThrow(`Invalid COINALYZE_BASE_URL: "${raw}"`);
  });

  test("rejects an AUTH_TOKEN shorter than 32 characters", () => {
    expect(() => loadConfig({ ...base, AUTH_TOKEN: "s".repeat(31) })).toThrow("AUTH_TOKEN must be at least 32 characters");
  });

  test.each([
    ["PORT", "65536"],
    ["INTERVAL_MS", "2147483648"],
    ["PING_INTERVAL_MS", "2147483648"],
    ["PONG_TIMEOUT_MS", "2147483648"],
    ["AUTH_TIMEOUT_MS", "2147483648"],
  ])("rejects %s=%p above its maximum", (name, raw) => {
    expect(() => loadConfig({ ...base, [name]: raw })).toThrow(`Invalid ${name}: "${raw}"`);
  });

  test("accepts the maxima", () => {
    expect(loadConfig({ ...base, PORT: "65535" }).port).toBe(65535);
    expect(loadConfig({ ...base, PING_INTERVAL_MS: "2147483646", PONG_TIMEOUT_MS: "2147483647" })).toMatchObject({
      pingIntervalMs: 2147483646,
      pongTimeoutMs: 2147483647,
    });
  });

  test("PONG_TIMEOUT_MS must exceed PING_INTERVAL_MS", () => {
    expect(() => loadConfig({ ...base, PING_INTERVAL_MS: "30000", PONG_TIMEOUT_MS: "30000" })).toThrow(
      "PONG_TIMEOUT_MS (30000) must be greater than PING_INTERVAL_MS (30000)",
    );
  });
});
