import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Health } from "../src/health.ts";
import { createServer } from "../src/server.ts";
import { SnapshotStore } from "../src/store.ts";
import type { Snapshot } from "../src/types.ts";
import { connectWs } from "./ws-client.ts";

const dir = await mkdtemp(join(tmpdir(), "coinalyze-server-"));
const store = new SnapshotStore({ file: join(dir, "funding_rate.json"), historyFile: join(dir, "history.sqlite"), historyLimit: 10 });

const snap = (timestamp: number): Snapshot => ({
  type: "snapshot",
  symbol: "ETH",
  coin: "ethereum",
  timestamp,
  aggregated_predicted_funding_rate: 0.01,
  oi_weighted_predicted_funding_rate: 0.012,
  markets: 7,
  unit: "percent_per_8h",
  components: [],
});

const seeded = snap(1);
await store.add([seeded]);

let health: Health = {
  httpStatus: 503,
  body: { status: "down", uptime_s: 0, interval_ms: 60000, last_success_at: null, consecutive_failures: 3, last_error: "x" },
};

const server = createServer({
  port: 0,
  authToken: "secret-token",
  // Real timer on purpose: the server enforces the auth deadline with its own setTimeout.
  authTimeoutMs: 200,
  pingIntervalMs: 60000,
  pongTimeoutMs: 120000,
  development: false,
  store,
  getHealth: () => health,
  meta: { coins: ["ETH"], intervalMs: 60000 },
  dashboard: new Response("dashboard"),
});

afterAll(async () => {
  server.stop();
  await rm(dir, { recursive: true, force: true });
});

const connect = () => connectWs(`ws://127.0.0.1:${server.port}/ws`);

test("valid auth receives metadata, history with the latest breakdown, then live snapshots", async () => {
  const client = connect();
  await client.opened;
  client.ws.send(JSON.stringify({ type: "auth", token: "secret-token" }));

  expect(await client.next()).toEqual({ type: "auth", status: "ok", coins: ["ETH"], interval_ms: 60000 });
  const { components: _, ...seededPoint } = seeded;
  expect(await client.next()).toEqual({ type: "history", points: [seededPoint], latest: [seeded] });

  const live = snap(2);
  await store.add([live]);
  expect(await client.next()).toEqual(live);

  client.ws.send("not json");
  expect(await client.next()).toEqual({ type: "error", message: "invalid json" });
  client.ws.close();
  await client.closed;
});

test("a wrong token is closed with 4001", async () => {
  const client = connect();
  await client.opened;
  client.ws.send(JSON.stringify({ type: "auth", token: "secret-tokeN" }));
  expect(await client.next()).toEqual({ type: "auth", status: "error", message: "invalid token" });
  expect((await client.closed).code).toBe(4001);
});

test("a client that never authenticates is closed with 4003", async () => {
  const client = connect();
  await client.opened;
  expect((await client.closed).code).toBe(4003);
});

test("a message of 16 KiB is parsed; one byte more closes the connection unparsed", async () => {
  const atCap = connect();
  await atCap.opened;
  atCap.ws.send("x".repeat(16 * 1024));
  expect(await atCap.next()).toEqual({ type: "error", message: "invalid json" });
  atCap.ws.close();
  await atCap.closed;

  const overCap = connect();
  await overCap.opened;
  overCap.ws.send("x".repeat(16 * 1024 + 1));
  // Bun sends a 1009 close frame on macOS but drops the connection without one on Linux (1006).
  expect([1006, 1009]).toContain((await overCap.closed).code);
  // An already-queued reply would win the race; none means the frame was never parsed.
  expect(await Promise.race([overCap.next(), Promise.resolve("no reply")])).toBe("no reply");
});

test("/health returns the computed status code and body", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ status: "down", consecutive_failures: 3 });

  health = { httpStatus: 200, body: { ...health.body, status: "ok", consecutive_failures: 0 } };
  expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
});
