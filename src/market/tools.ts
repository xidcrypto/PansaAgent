// Agent tools for market data. Both are read-only (signs: false), so they
// pass the gateway safety filter untouched and work via Telegram too.
// No SKILL.md docs on purpose (same reason as analyst): a doc would make
// the model load text instead of calling the tool that fetches live data.
import type { Tool } from "../agent.js";
import { getPrice, formatPriceResult } from "./price.js";
import { getCexMarket, formatCexMarket, type CexAction } from "./cex.js";

export function createPriceTool(deps: { fetchFn?: typeof fetch } = {}): Tool {
  return {
    name: "price",
    description:
      "Get a token's live price. Token contract/mint address (EVM 0x… or Solana base58) returns the best-liquidity Dexscreener pair (price, liquidity, 24h volume/change). Symbol (BTC, BTC/USDT, ETH) returns the Binance spot price. Read-only, never signs. A DEX price is not proof a sell succeeds — use analyst for trap checks.",
    parameters: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    signs: false,
    execute: async (args: Record<string, unknown>) => {
      const res = await getPrice(String(args.target ?? ""), { fetchFn: deps.fetchFn });
      if (!res.ok || !res.data) return { ok: false, data: null, error: res.error };
      return { ok: true, data: { ...res.data, text: formatPriceResult(res.data) } };
    },
  };
}

export function createCexTool(deps: { fetchFn?: typeof fetch } = {}): Tool {
  return {
    name: "cex",
    description:
      "Binance spot market data without an API key. Actions: price (last trade), ticker (24h stats), depth (top-5 order book), klines (candles; needs interval like 1h/4h/1d and optional limit 1-100). Symbol BTC, BTC/USDT, or BTCUSDT. A symbol Binance does not list is reported as not listed — that is the listing check. Read-only, never signs.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        action: { type: "string", enum: ["price", "ticker", "depth", "klines"] },
        interval: { type: "string" },
        limit: { type: "number" },
      },
      required: ["symbol", "action"],
    },
    signs: false,
    execute: async (args: Record<string, unknown>) => {
      const action = String(args.action ?? "") as CexAction;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const res = await getCexMarket(String(args.symbol ?? ""), action, {
        fetchFn: deps.fetchFn,
        interval: typeof args.interval === "string" ? args.interval : undefined,
        limit,
      });
      if (!res.ok || !res.data) return { ok: false, data: null, error: res.error };
      return { ok: true, data: { ...res.data, text: formatCexMarket(res.data) } };
    },
  };
}
