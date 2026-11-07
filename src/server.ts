import type { HTMLBundle, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { CoinSymbol } from "./coins.ts";
import { exportBody, parseExportQuery } from "./export.ts";
import type { Health } from "./health.ts";
import { createLogger } from "./log.ts";
import { CHANNEL, CLOSE, type ServerMessage } from "./protocol.ts";
import type { SnapshotStore } from "./store.ts";

const log = createLogger("server");
// Client messages are ~100 bytes. Bun closes on larger frames with 1009.
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

interface ClientData {
  authenticated: boolean;
  lastPong: number;
  authTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface ServerOptions {
  port: number;
  authToken: string;
  authTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  development: boolean;
  store: Pick<SnapshotStore, "history" | "latest" | "range" | "subscribe" | "subscribeBackfill">;
  getHealth: () => Health;
  meta: { coins: CoinSymbol[]; intervalMs: number };
  dashboard: HTMLBundle | Response;
}

export interface AppServer {
  port: number;
  stop(): void;
}

const tokenMatches = (candidate: unknown, expected: string): boolean => {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const bearerToken = (req: Request): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];

export const createServer = (opts: ServerOptions): AppServer => {
  const clients = new Set<ServerWebSocket<ClientData>>();
  const send = (ws: ServerWebSocket<ClientData>, msg: ServerMessage) => ws.send(JSON.stringify(msg));

  const server = Bun.serve({
    port: opts.port,
    development: opts.development,
    routes: {
      "/": opts.dashboard,
      "/health": () => {
        const h = opts.getHealth();
        return Response.json(h.body, { status: h.httpStatus });
      },
      "/export": {
        GET: (req) => {
          if (!tokenMatches(bearerToken(req), opts.authToken)) {
            log.warn("export: request rejected (invalid token)");
            return Response.json({ error: "invalid or missing token" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
          }
          const query = parseExportQuery(new URL(req.url).searchParams);
          if ("error" in query) return Response.json(query, { status: 400 });
          const csv = query.format === "csv";
          return new Response(exportBody(opts.store.range(query.symbol, query.from, query.to), query.format), {
            headers: {
              "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json",
              "Cache-Control": "no-store",
              ...(csv && { "Content-Disposition": `attachment; filename="${query.symbol}-predicted-funding.csv"` }),
            },
          });
        },
      },
    },
    fetch(req, server) {
      if (new URL(req.url).pathname !== "/ws") return new Response("Not found", { status: 404 });
      const upgraded = server.upgrade(req, {
        data: { authenticated: false, lastPong: Date.now(), authTimer: undefined },
      });
      return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
      data: {} as ClientData,
      open(ws) {
        ws.data.authTimer = setTimeout(() => ws.close(CLOSE.authTimeout, "auth timeout"), opts.authTimeoutMs);
        clients.add(ws);
      },
      message(ws, raw) {
        let msg: { type?: unknown; token?: unknown };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          send(ws, { type: "error", message: "invalid json" });
          return;
        }
        if (msg?.type === "auth") {
          if (!tokenMatches(msg.token, opts.authToken)) {
            log.warn("ws: client rejected (invalid token)");
            send(ws, { type: "auth", status: "error", message: "invalid token" });
            ws.close(CLOSE.invalidToken, "invalid token");
            return;
          }
          clearTimeout(ws.data.authTimer);
          ws.data.authTimer = undefined;
          ws.data.authenticated = true;
          ws.data.lastPong = Date.now();
          ws.subscribe(CHANNEL);
          send(ws, { type: "auth", status: "ok", coins: opts.meta.coins, interval_ms: opts.meta.intervalMs });
          send(ws, { type: "history", points: opts.store.history(), latest: opts.store.latest() });
          log.info(`ws: client authenticated (${clients.size} connected)`);
          return;
        }
        if (msg?.type === "pong") {
          if (ws.data.authenticated) ws.data.lastPong = Date.now();
          return;
        }
        send(ws, { type: "error", message: "unknown message type" });
      },
      close(ws) {
        clearTimeout(ws.data.authTimer);
        clients.delete(ws);
      },
    },
  });

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of clients) {
      if (!ws.data.authenticated) continue;
      if (now - ws.data.lastPong > opts.pongTimeoutMs) {
        ws.close(CLOSE.pongTimeout, "pong timeout");
        continue;
      }
      send(ws, { type: "ping" });
    }
  }, opts.pingIntervalMs);

  let stopped = false;
  opts.store.subscribe((s) => {
    if (!stopped) server.publish(CHANNEL, JSON.stringify(s));
  });
  // The channel holds only authenticated sockets; `clients` holds unauthenticated ones too.
  opts.store.subscribeBackfill((points) => {
    if (!stopped) server.publish(CHANNEL, JSON.stringify({ type: "backfill", points } satisfies ServerMessage));
  });

  return {
    port: server.port ?? opts.port,
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      server.stop(true);
    },
  };
};
