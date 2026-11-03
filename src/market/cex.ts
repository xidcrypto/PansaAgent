// Binance spot market data, keyless and read-only (public endpoints).
// Actions: price (last trade), ticker (24h stats), depth (top order book),
// klines (candles). A symbol Binance does not list is reported as such —
// that IS the listing check, not an error to hide.
import { normalizeBinanceSymbol } from "./price.js";

export type CexAction = "price" | "ticker" | "depth" | "klines";

const INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);

async function binanceGet(path: string, fetchFn: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(`https://api.binance.com${path}`, { signal: ctrl.signal });
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "msg" in data ? String((data as { msg: unknown }).msg) : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export interface CexMarket {
  source: "binance";
  symbol: string;
  action: CexAction;
  data: unknown;
}

export async function getCexMarket(
  symbolInput: string,
  action: CexAction,
  opts: { fetchFn?: typeof fetch; interval?: string; limit?: number } = {},
): Promise<{ ok: boolean; data?: CexMarket; error?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const symbol = normalizeBinanceSymbol(symbolInput);
  if (!symbol) return { ok: false, error: "Simbol kosong." };
  try {
    let data: unknown;
    if (action === "price") {
      const row = (await binanceGet(`/api/v3/ticker/price?symbol=${symbol}`, fetchFn)) as { price?: string };
      const price = parseFloat(row.price ?? "");
      if (!Number.isFinite(price)) return { ok: false, error: `Binance tidak mengembalikan harga untuk ${symbol}.` };
      data = { price };
    } else if (action === "ticker") {
      const row = (await binanceGet(`/api/v3/ticker/24hr?symbol=${symbol}`, fetchFn)) as Record<string, string>;
      data = {
        lastPrice: row.lastPrice,
        priceChangePercent: row.priceChangePercent,
        highPrice: row.highPrice,
        lowPrice: row.lowPrice,
        volume: row.volume,
        quoteVolume: row.quoteVolume,
        openPrice: row.openPrice,
      };
    } else if (action === "depth") {
      const row = (await binanceGet(`/api/v3/depth?symbol=${symbol}&limit=5`, fetchFn)) as {
        bids?: Array<[string, string]>;
        asks?: Array<[string, string]>;
      };
      data = { bids: row.bids ?? [], asks: row.asks ?? [] };
    } else if (action === "klines") {
      const interval = opts.interval ?? "1h";
      if (!INTERVALS.has(interval)) return { ok: false, error: `Interval tidak valid: ${interval}. Pakai salah satu: ${[...INTERVALS].join(", ")}.` };
      const limit = Math.min(Math.max(Math.floor(opts.limit ?? 24), 1), 100);
      const rows = (await binanceGet(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, fetchFn)) as Array<
        [number, string, string, string, string, string]
      >;
      data = {
        interval,
        candles: rows.map(([openTime, open, high, low, close, volume]) => ({ openTime, open, high, low, close, volume })),
      };
    } else {
      return { ok: false, error: `Aksi tidak dikenal: ${action}. Pakai price, ticker, depth, atau klines.` };
    }
    return { ok: true, data: { source: "binance", symbol, action, data } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Invalid symbol/i.test(msg)) return { ok: false, error: `Simbol ${symbol} tidak terdaftar di Binance (spot).` };
    return { ok: false, error: msg };
  }
}

export function formatCexMarket(m: CexMarket): string {
  const d = m.data as Record<string, unknown>;
  if (m.action === "price") return `${m.symbol}: $${d.price} (Binance spot).`;
  if (m.action === "ticker") {
    return [
      `${m.symbol}: $${d.lastPrice} (${d.priceChangePercent}% 24h)`,
      `High/low 24h: $${d.highPrice} / $${d.lowPrice}`,
      `Volume 24h: ${d.volume} (${m.symbol.replace(/USDT|USDC|FDUSD|BTC|ETH|BNB|TRY|EUR|USD$/, "")}), $${d.quoteVolume} quote`,
      "Sumber: Binance spot.",
    ].join("\n");
  }
  if (m.action === "depth") {
    const bids = (d.bids as Array<[string, string]>).map(([p, q]) => `${p} x ${q}`).join(", ");
    const asks = (d.asks as Array<[string, string]>).map(([p, q]) => `${p} x ${q}`).join(", ");
    return [`${m.symbol} order book (top 5):`, `Bids: ${bids || "-"}`, `Asks: ${asks || "-"}`].join("\n");
  }
  const candles = (d.candles as Array<Record<string, unknown>>).map(
    (c) => `${new Date(Number(c.openTime)).toISOString()} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`,
  );
  return [`${m.symbol} candles ${d.interval}:`, ...candles].join("\n");
}
