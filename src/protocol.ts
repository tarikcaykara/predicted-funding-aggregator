import type { CoinSymbol } from "./coins.ts";
import type { HistoryPoint, Snapshot } from "./types.ts";

/** Points per coin kept in memory by the server, sent in the `history` message, and kept by the dashboard. */
export const HISTORY_LIMIT = 720;

export const CHANNEL = "funding-rate";

export type ClientMessage = { type: "auth"; token: string } | { type: "pong" };

export type ServerMessage =
  | { type: "auth"; status: "ok"; coins: CoinSymbol[]; interval_ms: number }
  | { type: "auth"; status: "error"; message: string }
  | { type: "history"; points: HistoryPoint[]; latest: Snapshot[] }
  | { type: "ping" }
  | { type: "error"; message: "invalid json" | "unknown message type" }
  | Snapshot;

/** WebSocket close codes. */
export const CLOSE = {
  invalidToken: 4001,
  pongTimeout: 4002,
  authTimeout: 4003,
} as const;
