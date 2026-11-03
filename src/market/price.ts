// Market price lookups, keyless and read-only.
// - Token contract/mint address (EVM 0x… or Solana base58) -> Dexscreener
//   best-liquidity pair (same source the analyst and price alerts use).
// - Symbol (BTC, BTC/USDT, BTCUSDT) -> Binance spot ticker.
// No signing, no API key, no account. Timeouts are hard (10 s) so a dead
// upstream fails fast instead of stalling the agent.
import { isSolanaAddress } from "../analyst/solana.js";

export function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export interface DexPrice {
  source: "dexscreener";
  target: string;
  priceUsd?: number;
  priceNative?: number;
  priceNativeSymbol?: string;
  liquidityUsd?: number;
  volumeH24?: number;
  changeH24?: number;
  pairCount: number;
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseSymbol?: string;
  quoteSymbol?: string;
}

export interface BinancePrice {
  source: "binance";
  symbol: string;
  price: number;
  changePercent24h?: number;
  high24h?: number;
  low24h?: number;
  volume24h?: number;
  quoteVolume24h?: number;
}

export type PriceResult = DexPrice | BinancePrice;

async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
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

export async function fetchDexPrice(address: string, fetchFn: typeof fetch = fetch): Promise<DexPrice> {
  const data = (await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`, fetchFn)) as {
    pairs?: Array<{
      priceUsd?: string;
      priceNative?: string;
      liquidity?: { usd?: number };
      volume?: { h24?: number };
      priceChange?: { h24?: number };
      chainId?: string;
      dexId?: string;
      pairAddress?: string;
      baseToken?: { symbol?: string };
      quoteToken?: { symbol?: string };
    }>;
  };
  const pairs = data.pairs ?? [];
  if (!pairs.length) {
    return { source: "dexscreener", target: address, pairCount: 0 };
  }
  let best = pairs[0];
  for (const p of pairs) {
    if ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  const priceUsd = best.priceUsd === undefined ? NaN : parseFloat(best.priceUsd);
  const priceNative = best.priceNative === undefined ? NaN : parseFloat(best.priceNative);
  return {
    source: "dexscreener",
    target: address,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : undefined,
    priceNative: Number.isFinite(priceNative) ? priceNative : undefined,
    priceNativeSymbol: best.quoteToken?.symbol,
    liquidityUsd: best.liquidity?.usd,
    volumeH24: best.volume?.h24,
    changeH24: best.priceChange?.h24,
    pairCount: pairs.length,
    chainId: best.chainId,
    dexId: best.dexId,
    pairAddress: best.pairAddress,
    baseSymbol: best.baseToken?.symbol,
    quoteSymbol: best.quoteToken?.symbol,
  };
}

// Normalize a user symbol to a Binance spot pair: strip separators, upper
// case, and default a bare asset (BTC) to its USDT pair. Anything already
// ending in a known quote asset is left alone.
const QUOTES = ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB", "TRY", "EUR", "USD"];
export function normalizeBinanceSymbol(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return "";
  if (QUOTES.some((q) => clean.length > q.length && clean.endsWith(q))) return clean;
  return `${clean}USDT`;
}

export async function fetchBinancePrice(symbolInput: string, fetchFn: typeof fetch = fetch): Promise<BinancePrice> {
  const symbol = normalizeBinanceSymbol(symbolInput);
  if (!symbol) throw new Error("Simbol kosong.");
  let data: {
    symbol?: string;
    lastPrice?: string;
    priceChangePercent?: string;
    highPrice?: string;
    lowPrice?: string;
    volume?: string;
    quoteVolume?: string;
  };
  try {
    data = (await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, fetchFn)) as typeof data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Invalid symbol/i.test(msg)) throw new Error(`Simbol ${symbol} tidak terdaftar di Binance (spot).`);
    throw err;
  }
  const price = parseFloat(data.lastPrice ?? "");
  if (!Number.isFinite(price)) throw new Error(`Binance tidak mengembalikan harga untuk ${symbol}.`);
  const num = (v?: string) => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    source: "binance",
    symbol,
    price,
    changePercent24h: num(data.priceChangePercent),
    high24h: num(data.highPrice),
    low24h: num(data.lowPrice),
    volume24h: num(data.volume),
    quoteVolume24h: num(data.quoteVolume),
  };
}

export async function getPrice(
  target: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{ ok: boolean; data?: PriceResult; error?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const t = target.trim();
  if (!t) return { ok: false, error: "Butuh target: alamat token (0x… / base58 Solana) atau simbol (BTC, BTC/USDT)." };
  try {
    if (isEvmAddress(t) || isSolanaAddress(t)) {
      const dex = await fetchDexPrice(t, fetchFn);
      if (dex.pairCount === 0) return { ok: false, error: `Tidak ada pair Dexscreener untuk ${t} (belum listing di DEX / alamat salah).` };
      if (dex.priceUsd === undefined) return { ok: false, error: `Pair ditemukan (${dex.pairCount}) tapi harga tidak tersedia.` };
      return { ok: true, data: dex };
    }
    const bin = await fetchBinancePrice(t, fetchFn);
    return { ok: true, data: bin };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatPriceResult(r: PriceResult): string {
  if (r.source === "binance") {
    const lines = [`${r.symbol}: $${r.price}`];
    if (r.changePercent24h !== undefined) lines.push(`24h: ${r.changePercent24h}%`);
    if (r.high24h !== undefined && r.low24h !== undefined) lines.push(`High/low 24h: $${r.high24h} / $${r.low24h}`);
    if (r.quoteVolume24h !== undefined) lines.push(`Volume 24h: $${r.quoteVolume24h}`);
    lines.push("Sumber: Binance spot (tanpa API key).");
    return lines.join("\n");
  }
  const lines = [`${r.baseSymbol ?? r.target}: $${r.priceUsd}`];
  if (r.priceNative !== undefined && r.priceNativeSymbol) lines.push(`Harga native: ${r.priceNative} ${r.priceNativeSymbol}`);
  if (r.changeH24 !== undefined) lines.push(`24h: ${r.changeH24}%`);
  if (r.liquidityUsd !== undefined) lines.push(`Likuiditas: $${r.liquidityUsd}`);
  if (r.volumeH24 !== undefined) lines.push(`Volume 24h: $${r.volumeH24}`);
  lines.push(`Pair: ${r.dexId ?? "?"} (${r.chainId ?? "?"}) — ${r.pairCount} pair ditemukan, dipakai yang likuiditas terbesar.`);
  lines.push("Sumber: Dexscreener (tanpa API key). Harga DEX bukan bukti bisa jual (cek analyst untuk trap).");
  return lines.join("\n");
}
