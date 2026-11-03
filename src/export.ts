import { COIN_REGISTRY, isCoinSymbol, type CoinSymbol } from "./coins.ts";
import type { HistoryPoint } from "./types.ts";

export type ExportFormat = "csv" | "json";

export interface ExportQuery {
  symbol: CoinSymbol;
  /** Inclusive, ms since the epoch. */
  from: number;
  /** Exclusive, ms since the epoch. */
  to: number;
  format: ExportFormat;
}

const SUPPORTED = Object.keys(COIN_REGISTRY).join(", ");
const CSV_HEADER =
  "timestamp,time,symbol,aggregated_predicted_funding_rate,oi_weighted_predicted_funding_rate,markets,open_interest_usd\n";

const epochMs = (params: URLSearchParams, name: "from" | "to", fallback: number): number | { error: string } => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(value)
    ? value
    : { error: `"${name}" must be a whole number of milliseconds since the epoch` };
};

/** Validates `GET /export?symbol=&from=&to=&format=`. */
export const parseExportQuery = (params: URLSearchParams): ExportQuery | { error: string } => {
  const rawSymbol = params.get("symbol");
  if (!rawSymbol) return { error: `missing "symbol" (supported: ${SUPPORTED})` };
  const symbol = rawSymbol.toUpperCase();
  if (!isCoinSymbol(symbol)) return { error: `unknown symbol "${rawSymbol}" (supported: ${SUPPORTED})` };
  const from = epochMs(params, "from", 0);
  if (typeof from !== "number") return from;
  const to = epochMs(params, "to", Number.MAX_SAFE_INTEGER);
  if (typeof to !== "number") return to;
  if (from >= to) return { error: `"from" must be less than "to"` };
  const format = params.get("format") ?? "csv";
  if (format !== "csv" && format !== "json") return { error: `unknown format "${format}" (csv or json)` };
  return { symbol, from, to, format };
};

const csvRow = (p: HistoryPoint): string =>
  `${p.timestamp},${new Date(p.timestamp).toISOString()},${p.symbol},${p.aggregated_predicted_funding_rate},` +
  `${p.oi_weighted_predicted_funding_rate ?? ""},${p.markets},${p.open_interest_usd ?? ""}\n`;

/** Streams pages of points as one CSV document or one JSON array, pulling a page only when the client reads. */
export const exportBody = (pages: Iterator<HistoryPoint[]>, format: ExportFormat): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let empty = true;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(format === "csv" ? CSV_HEADER : "["));
    },
    // A pull that enqueues nothing may not be called again, so skip empty pages here.
    pull(controller) {
      let page = pages.next();
      while (!page.done && page.value.length === 0) page = pages.next();
      if (page.done) {
        if (format === "json") controller.enqueue(encoder.encode("]"));
        controller.close();
        return;
      }
      if (format === "csv") {
        controller.enqueue(encoder.encode(page.value.map(csvRow).join("")));
        return;
      }
      const items = page.value.map((p) => JSON.stringify(p)).join(",");
      controller.enqueue(encoder.encode(empty ? items : `,${items}`));
      empty = false;
    },
  });
};
