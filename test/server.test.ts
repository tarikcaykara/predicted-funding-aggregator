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
  open_interest_usd: 2_500_000_000,
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
  expect((await overCap.closed).code).toBe(1009);
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

const exportUrl = (query: string) => `http://127.0.0.1:${server.port}/export?${query}`;
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

test("/export needs the token in an Authorization: Bearer header", async () => {
  for (const init of [{}, bearer("secret-tokeN"), { headers: { Authorization: "secret-token" } }]) {
    const res = await fetch(exportUrl("symbol=ETH"), init);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  }
  // A token in the URL would end up in access logs and browser history.
  expect((await fetch(exportUrl("symbol=ETH&token=secret-token"))).status).toBe(401);
});

test("/export returns one coin's stored points in [from, to) as CSV or JSON", async () => {
  const points = [{ ...snap(1000), oi_weighted_predicted_funding_rate: null, open_interest_usd: null }, snap(2000), snap(3000)];
  await store.add(points);

  const csv = await fetch(exportUrl("symbol=eth&from=1000&to=3000"), bearer("secret-token"));
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(csv.headers.get("cache-control")).toBe("no-store");
  expect(await csv.text()).toBe(
    "timestamp,time,symbol,aggregated_predicted_funding_rate,oi_weighted_predicted_funding_rate,markets,open_interest_usd\n" +
      "1000,1970-01-01T00:00:01.000Z,ETH,0.01,,7,\n" +
      "2000,1970-01-01T00:00:02.000Z,ETH,0.01,0.012,7,2500000000\n",
  );

  const json = await fetch(exportUrl("symbol=ETH&from=1000&to=3000&format=json"), bearer("secret-token"));
  expect(json.headers.get("content-type")).toBe("application/json");
  expect(await json.json()).toEqual(points.slice(0, 2).map(({ components: _, ...point }) => point));
});

test("/export answers an invalid query with 400 and the reason", async () => {
  const res = await fetch(exportUrl("symbol=DOGE"), bearer("secret-token"));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'unknown symbol "DOGE" (supported: BTC, ETH, SOL)' });
});
