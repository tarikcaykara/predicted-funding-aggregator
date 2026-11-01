import { COIN_REGISTRY, isCoinSymbol, type CoinSymbol } from "./coins.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  coinalyzeApiKey: string;
  coinalyzeBaseUrl: string | undefined;
  coins: CoinSymbol[];
  intervalMs: number;
  dataFile: string;
  historyFile: string;
  port: number;
  authToken: string;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  authTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

/** setTimeout/setInterval run larger delays after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_PORT = 65_535;
const MIN_AUTH_TOKEN_LENGTH = 32;

const positiveInt = (env: Env, name: string, fallback: number, max = MAX_TIMER_MS): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value <= 0 || value > max) {
    throw new ConfigError(`Invalid ${name}: "${raw}" (whole number 1–${max})`);
  }
  return value;
};

const required = (env: Env, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required env var ${name}`);
  return value;
};

const authToken = (env: Env): string => {
  const token = required(env, "AUTH_TOKEN");
  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(`AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters (e.g. openssl rand -hex 32)`);
  }
  return token;
};

/** Optional override for tests and proxies; `undefined` keeps CoinalyzeClient's default. */
const baseUrl = (env: Env): string | undefined => {
  const raw = env.COINALYZE_BASE_URL?.trim();
  if (!raw) return undefined;
  if (!URL.canParse(raw) || !["http:", "https:"].includes(new URL(raw).protocol)) {
    throw new ConfigError(`Invalid COINALYZE_BASE_URL: "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
};

// "".split(",") yields [""], so an empty list fails the membership check below.
const parseCoins = (raw: string): CoinSymbol[] => {
  const coins: CoinSymbol[] = [];
  for (const value of new Set(raw.split(",").map((s) => s.trim().toUpperCase()))) {
    if (!isCoinSymbol(value)) {
      const supported = Object.keys(COIN_REGISTRY).join(", ");
      throw new ConfigError(`Invalid COINS entry "${value}" (supported: ${supported})`);
    }
    coins.push(value);
  }
  return coins;
};

export const loadConfig = (env: Env): Config => {
  const config: Config = {
    coinalyzeApiKey: required(env, "COINALYZE_API_KEY"),
    coinalyzeBaseUrl: baseUrl(env),
    coins: parseCoins(env.COINS ?? "BTC,ETH,SOL"),
    intervalMs: positiveInt(env, "INTERVAL_MS", 60000),
    dataFile: env.DATA_FILE?.trim() || "./funding_rate.json",
    historyFile: env.HISTORY_FILE?.trim() || "./history.sqlite",
    port: positiveInt(env, "PORT", 3000, MAX_PORT),
    authToken: authToken(env),
    pingIntervalMs: positiveInt(env, "PING_INTERVAL_MS", 30000),
    pongTimeoutMs: positiveInt(env, "PONG_TIMEOUT_MS", 65000),
    authTimeoutMs: positiveInt(env, "AUTH_TIMEOUT_MS", 10000),
  };
  if (config.pongTimeoutMs <= config.pingIntervalMs) {
    throw new ConfigError(
      `PONG_TIMEOUT_MS (${config.pongTimeoutMs}) must be greater than PING_INTERVAL_MS (${config.pingIntervalMs})`,
    );
  }
  return config;
};
