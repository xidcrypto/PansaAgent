// Portfolio: read-only balance + value overview across registry wallets.
//
// Read-only by construction: it only calls eth_call-style reads (native
// balance, ERC20 balanceOf/symbol/decimals) plus the public DexScreener
// price API. It never unlocks a wallet, never signs, never approves, and
// never broadcasts. A wallet whose lookup fails is reported with an
// error line instead of failing the whole report, and any USD figure is
// labelled partial when some holding has no known price — a missing
// price is never silently treated as zero.

import { formatEth } from "../evm-rpc.js";

export interface TokenHolding {
  address: string;
  symbol?: string;
  decimals?: number;
  /** Raw uint256 as a decimal string; "" when the read failed. */
  balanceRaw: string;
  /** Human-readable amount (decimals applied), or the raw value when
   *  decimals are unknown. "" when the read failed. */
  balance: string;
  usd?: number;
  error?: string;
}

export interface WalletPortfolio {
  name: string;
  address: string;
  family: string;
  /** Formatted native amount (ETH/BNB units). Undefined when unread. */
  nativeBalance?: string;
  nativeUsd?: number;
  tokens: TokenHolding[];
  /** Sum of the USD parts that are known; undefined when none are. */
  totalUsd?: number;
  error?: string;
}

export interface PortfolioDeps {
  getNativeBalance(address: string): Promise<bigint>;
  getChainId(): Promise<number>;
  /** Raw eth_call; returns the 0x result hex. */
  call(to: string, data: string): Promise<string>;
  /** USD price for an ERC20 token address; undefined when unknown. */
  priceFn(token: string): Promise<number | undefined>;
  /** USD price for the chain's native coin; undefined when unknown. */
  nativePriceFn(chainId: number): Promise<number | undefined>;
}

const BALANCE_OF = "0x70a08231";
const SYMBOL = "0x95d89b41";
const DECIMALS = "0x313ce567";

function padAddress(address: string): string {
  return "0".repeat(24) + address.toLowerCase().replace(/^0x/, "");
}

function decodeUint(hex: string): bigint {
  return BigInt(hex);
}

function decodeAbiString(hex: string): string | undefined {
  try {
    const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (b.length < 64) return undefined;
    const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
    if (!Number.isFinite(len) || len < 0 || 64 + len > b.length) return undefined;
    return b.subarray(64, 64 + len).toString("utf8");
  } catch {
    return undefined;
  }
}

function decodeBytes32String(hex: string): string | undefined {
  try {
    const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
    const end = b.indexOf(0);
    const s = b.subarray(0, end === -1 ? b.length : end).toString("utf8");
    return s.length ? s : undefined;
  } catch {
    return undefined;
  }
}

function formatUnits(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function readToken(
  token: string,
  walletAddress: string,
  deps: PortfolioDeps,
): Promise<TokenHolding> {
  const holding: TokenHolding = { address: token, balanceRaw: "", balance: "" };
  try {
    const raw = await deps.call(token, BALANCE_OF + padAddress(walletAddress));
    const value = decodeUint(raw);
    holding.balanceRaw = value.toString();
    let decimals: number | undefined;
    try {
      decimals = Number(decodeUint(await deps.call(token, DECIMALS)));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) decimals = undefined;
    } catch {
      decimals = undefined;
    }
    let symbol: string | undefined;
    try {
      symbol = decodeAbiString(await deps.call(token, SYMBOL)) ?? decodeBytes32String(await deps.call(token, SYMBOL));
    } catch {
      symbol = undefined;
    }
    holding.decimals = decimals;
    holding.symbol = symbol;
    holding.balance = decimals === undefined ? value.toString() : formatUnits(value, decimals);
    try {
      const price = await deps.priceFn(token);
      if (price !== undefined) holding.usd = parseFloat(holding.balance) * price;
    } catch {
      // Price unknown: leave usd undefined, never fake it.
    }
  } catch (err) {
    holding.error = err instanceof Error ? err.message : String(err);
  }
  return holding;
}

export async function getWalletPortfolio(
  wallet: { name: string; address: string; family: string },
  tokens: string[],
  deps: PortfolioDeps,
): Promise<WalletPortfolio> {
  const out: WalletPortfolio = { name: wallet.name, address: wallet.address, family: wallet.family, tokens: [] };
  if (wallet.family !== "evm") {
    out.error = `Saldo lookup belum didukung untuk ${wallet.family} (hanya EVM via RPC).`;
    return out;
  }
  try {
    const native = await deps.getNativeBalance(wallet.address);
    const formatted = await formatEth(native);
    out.nativeBalance = formatted;
    try {
      const chainId = await deps.getChainId();
      const price = await deps.nativePriceFn(chainId);
      if (price !== undefined) out.nativeUsd = parseFloat(formatted) * price;
    } catch {
      // Native price unknown: balance stays, USD stays undefined.
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
  for (const token of tokens) {
    out.tokens.push(await readToken(token, wallet.address, deps));
  }
  const parts = [
    ...(out.nativeUsd !== undefined ? [out.nativeUsd] : []),
    ...out.tokens.map((t) => t.usd).filter((v): v is number => v !== undefined),
  ];
  if (parts.length) out.totalUsd = parts.reduce((a, b) => a + b, 0);
  return out;
}

export async function getPortfolio(
  wallets: Array<{ name: string; address: string; family: string }>,
  tokens: string[],
  deps: PortfolioDeps,
): Promise<WalletPortfolio[]> {
  const out: WalletPortfolio[] = [];
  for (const wallet of wallets) {
    out.push(await getWalletPortfolio(wallet, tokens, deps));
  }
  return out;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatPortfolio(portfolios: WalletPortfolio[]): string {
  if (!portfolios.length) return "Portfolio: (kosong — belum ada dompet di registry)";
  const lines: string[] = [];
  let grandTotal = 0;
  let grandPriced = false;
  for (const p of portfolios) {
    lines.push(`${p.family} ${p.name}: ${p.address}`);
    if (p.error) {
      lines.push(`  gagal: ${p.error}`);
      continue;
    }
    if (p.nativeBalance !== undefined) {
      lines.push(`  Native: ${p.nativeBalance}${p.nativeUsd !== undefined ? ` (${usd(p.nativeUsd)})` : " (harga tidak tersedia)"}`);
    }
    for (const t of p.tokens) {
      if (t.error) {
        lines.push(`  Token ${t.address}: gagal: ${t.error}`);
      } else {
        lines.push(`  Token ${t.symbol ?? t.address}: ${t.balance}${t.usd !== undefined ? ` (${usd(t.usd)})` : " (harga tidak tersedia)"}`);
      }
    }
    if (p.totalUsd !== undefined) {
      lines.push(`  Total (bagian yang ada harganya): ${usd(p.totalUsd)}`);
      grandTotal += p.totalUsd;
      grandPriced = true;
    }
  }
  if (grandPriced) lines.push(`TOTAL SEMUA DOMPET (bagian yang ada harganya): ${usd(grandTotal)}`);
  return lines.join("\n");
}

// Default price lookups against the public DexScreener API. Both fail
// closed (undefined) on any error, timeout, or unparseable response —
// callers must never present an unknown price as zero.

async function fetchJson(url: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function dexscreenerTokenPrice(token: string, fetchFn: typeof fetch = fetch): Promise<number | undefined> {
  const data = (await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`, fetchFn)) as
    | { pairs?: Array<{ priceUsd?: string }> }
    | undefined;
  const raw = data?.pairs?.[0]?.priceUsd;
  const price = raw === undefined ? NaN : parseFloat(raw);
  return Number.isFinite(price) ? price : undefined;
}

// Native-coin price without hardcoding wrapped-token addresses: search
// DexScreener for the wrapped symbol on the chain and take the first
// pair on that chain whose base token matches. Unknown chains return
// undefined (no price invented).
const NATIVE_SEARCH: Record<number, string> = { 1: "WETH", 56: "WBNB" };

export async function dexscreenerNativePrice(chainId: number, fetchFn: typeof fetch = fetch): Promise<number | undefined> {
  const symbol = NATIVE_SEARCH[chainId];
  if (!symbol) return undefined;
  const data = (await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${symbol}`, fetchFn)) as
    | { pairs?: Array<{ chainId?: number | string; baseToken?: { symbol?: string }; priceUsd?: string }> }
    | undefined;
  const pair = data?.pairs?.find(
    (p) => Number(p.chainId) === chainId && p.baseToken?.symbol?.toUpperCase() === symbol,
  );
  const price = pair?.priceUsd === undefined ? NaN : parseFloat(pair.priceUsd);
  return Number.isFinite(price) ? price : undefined;
}
