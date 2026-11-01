import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthBody } from "../src/health.ts";
import type { ServerMessage } from "../src/protocol.ts";
import type { Snapshot } from "../src/types.ts";
import { FAKE_API_KEY, RATE_8H, startFakeCoinalyze, type FakeCoinalyze } from "./fake-coinalyze.ts";
import { connectWs } from "./ws-client.ts";

// src/main.ts runs as a child process against a loopback fake of the Coinalyze API.
// INTERVAL_MS=60000 with one coin: the first cycle costs 1 + 10 + 10 = 21 of 40 calls and its spare
// budget covers every market's open interest, so the first poll already has OI-weighted.

const ROOT = join(import.meta.dir, "..");
const TOKEN = "e2e-token-".padEnd(64, "0");

type HistoryMessage = Extract<ServerMessage, { type: "history" }>;

let root: string;
let fake: FakeCoinalyze;
const procs: Bun.Subprocess[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pfa-e2e-"));
  fake = startFakeCoinalyze();
});

afterEach(() => {
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
  fake.oiStatus = 200;
});

afterAll(async () => {
  fake.stop();
  await rm(root, { recursive: true, force: true });
});

/** The config rejects PORT=0, so reserve a free port and release it for the child. */
const freePort = (): number => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
};

/** Sets every config variable, so a developer's `.env` or shell cannot change the scenario. */
const serviceEnv = (dir: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  COINALYZE_API_KEY: FAKE_API_KEY,
  COINALYZE_BASE_URL: fake.url,
  AUTH_TOKEN: TOKEN,
  COINS: "BTC",
  INTERVAL_MS: "60000",
  PING_INTERVAL_MS: "30000",
  PONG_TIMEOUT_MS: "65000",
  AUTH_TIMEOUT_MS: "10000",
  PORT: String(freePort()),
  DATA_FILE: join(dir, "funding_rate.json"),
  HISTORY_FILE: join(dir, "history.sqlite"),
  ...overrides,
});

/** `stderr` drains the pipe, so the child never blocks on it, and resolves when the child exits. */
const start = (dir: string, env: Record<string, string>) => {
  const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/main.ts")], {
    cwd: dir,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  procs.push(proc);
  return { proc, stderr: new Response(proc.stderr).text() };
};

/** The child runs on the real clock and exposes no event to await, so poll its /health until a cycle succeeded. */
const waitForPoll = async (port: string): Promise<HealthBody> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as HealthBody;
      if (body.last_success_at !== null) return body;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error("no successful poll within 15 s");
};

const authenticate = async (port: string) => {
  const client = connectWs(`ws://127.0.0.1:${port}/ws`);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  const auth = await client.next();
  const history = (await client.next()) as HistoryMessage;
  return { client, auth, history };
};

test(
  "a cold start polls the fake API and serves WS, /health, DATA_FILE and the dashboard",
  async () => {
    const dir = await mkdtemp(join(root, "cold-"));
    const env = serviceEnv(dir);
    const { proc } = start(dir, env);

    expect(await waitForPoll(env.PORT!)).toMatchObject({
      status: "ok",
      interval_ms: 60000,
      consecutive_failures: 0,
      last_error: null,
    });

    const { client, auth, history } = await authenticate(env.PORT!);
    expect(auth).toEqual({ type: "auth", status: "ok", coins: ["BTC"], interval_ms: 60000 });
    expect(history.points).toHaveLength(1);
    expect(history.latest).toHaveLength(1);
    const latest = history.latest[0]!;
    expect(latest).toMatchObject({ symbol: "BTC", coin: "bitcoin", markets: 7 });
    expect(latest.aggregated_predicted_funding_rate).toBeCloseTo(RATE_8H, 12);
    expect(latest.oi_weighted_predicted_funding_rate!).toBeCloseTo(RATE_8H, 12);
    expect(latest.components).toHaveLength(10);
    expect(latest.components.filter((c) => c.status === "used")).toHaveLength(7);
    expect(
      latest.components
        .filter((c) => c.status === "no_rate")
        .map((c) => c.venue)
        .sort(),
    ).toEqual(["DERIBIT", "HUOBI", "OKX"]);
    client.ws.close();

    expect(JSON.parse(await Bun.file(env.DATA_FILE!).text())).toEqual(history.latest);

    const page = await fetch(`http://127.0.0.1:${env.PORT}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('id="venue-row"');

    const intruder = connectWs(`ws://127.0.0.1:${env.PORT}/ws`);
    await intruder.opened;
    intruder.ws.send(JSON.stringify({ type: "auth", token: TOKEN.slice(0, -1) + "1" }));
    expect(await intruder.next()).toEqual({ type: "auth", status: "error", message: "invalid token" });
    expect((await intruder.closed).code).toBe(4001);

    expect(fake.requests).toEqual(
      expect.arrayContaining(["/v1/future-markets", "/v1/predicted-funding-rate", "/v1/open-interest"]),
    );

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  },
  30_000,
);

test(
  "a restart serves the persisted history and seeds OI from DATA_FILE",
  async () => {
    const dir = await mkdtemp(join(root, "restart-"));
    const env1 = serviceEnv(dir);
    const run1 = start(dir, env1);
    await waitForPoll(env1.PORT!);
    const session1 = await authenticate(env1.PORT!);
    const first: Snapshot = session1.history.latest[0]!;
    session1.client.ws.close();
    run1.proc.kill("SIGTERM");
    expect(await run1.proc.exited).toBe(0);

    // Every OI request of the second run fails, so a non-null OI-weighted can only come from the seed.
    fake.oiStatus = 500;
    const before = fake.requests.length;
    const env2 = { ...env1, PORT: String(freePort()) };
    const run2 = start(dir, env2);
    await waitForPoll(env2.PORT);
    const { client, history } = await authenticate(env2.PORT);
    const timestamps = history.points.map((p) => p.timestamp);
    expect(timestamps).toHaveLength(2);
    expect(timestamps[0]).toBe(first.timestamp);
    const latest = history.latest[0]!;
    expect(latest.timestamp).toBeGreaterThan(first.timestamp);
    expect(latest.oi_weighted_predicted_funding_rate!).toBeCloseTo(RATE_8H, 12);
    expect(fake.requests.slice(before)).toContain("/v1/open-interest");
    client.ws.close();

    run2.proc.kill("SIGTERM");
    expect(await run2.proc.exited).toBe(0);
  },
  30_000,
);

test(
  "invalid startup config exits 1 before calling the API",
  async () => {
    const dir = await mkdtemp(join(root, "config-"));
    const before = fake.requests.length;

    const coins = start(dir, serviceEnv(dir, { COINS: "DOGE" }));
    expect(await coins.proc.exited).toBe(1);
    expect(await coins.stderr).toContain('Invalid COINS entry "DOGE"');

    const token = start(dir, serviceEnv(dir, { AUTH_TOKEN: "short" }));
    expect(await token.proc.exited).toBe(1);
    expect(await token.stderr).toContain("AUTH_TOKEN must be at least 32 characters");

    const historyFile = start(dir, serviceEnv(dir, { HISTORY_FILE: dir }));
    expect(await historyFile.proc.exited).toBe(1);
    expect(await historyFile.stderr).toContain("cannot open HISTORY_FILE");

    expect(fake.requests).toHaveLength(before);
  },
  15_000,
);
