// Swap flows, one router per chain family.
// - EVM: Paraswap v5 (keyless quote + build, verified live from the VPS).
//   Quote -> build -> (ERC20 approval check) -> human confirmation via
//   the existing requestConfirmation pipeline -> `pansa confirm` ->
//   existing EVM execute path. The agent NEVER signs or broadcasts.
// - Solana: Jupiter v1 quote only (verified live). Execution is NOT wired:
//   PansaAgent has no Solana signing/broadcast path yet, so a Solana
//   swap stops at an honest quote instead of a fake confirmation.
// - Sui/Aptos: no keyless REST aggregator verified (Cetus/7k/Panora are
//   SDK- or key-gated) — reported as unsupported, not faked.
// Policy notes: the default policy is testnetOnly, so mainnet swaps are
// policy-rejected until the owner relaxes it deliberately (`pansa policy
// set`). Policy caps cover native value only; ERC20 amounts are NOT
// capped by spendCapPerTx, so the full quote (in/out/minOut) is attached
// to the confirmation note and shown before any human confirms.
import { walletRegistryLoad } from "../signer/keystore.js";
import { requestConfirmation } from "../signer/policy.js";
import { getPolicy } from "../signer/policy.js";
import { getSpentToday } from "../signer/ledger.js";
import { resolveRpc } from "../rpc/index.js";
import { evmPublicClient, isTestnetChainId } from "../evm-rpc.js";
import type { TxRequest } from "../signer/transactions.js";

export const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const PARASWAP_CHAINS = new Set(["1", "56", "137", "42161", "10", "8453", "43114"]);

export function normalizeEvmToken(input: string): string | undefined {
  const t = input.trim().toLowerCase();
  if (t === "native" || t === "bnb" || t === "eth") return NATIVE_TOKEN;
  if (/^0x[0-9a-f]{40}$/.test(t)) return t;
  return undefined;
}

export function parseHumanAmount(amount: string, decimals: number): bigint | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return undefined;
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) return undefined;
  try {
    return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  } catch {
    return undefined;
  }
}

export function formatUnits(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

export function minOutRaw(destAmount: string, slippageBps: number): string {
  const d = BigInt(destAmount);
  return ((d * BigInt(10000 - slippageBps)) / 10000n).toString();
}

async function fetchJson(url: string, fetchFn: typeof fetch, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export interface ParaswapQuote {
  srcAmount: string;
  destAmount: string;
  priceRoute: unknown;
}

export async function paraswapQuote(
  chainId: string,
  fromToken: string,
  toToken: string,
  amountRaw: string,
  srcDecimals: number,
  destDecimals: number,
  fetchFn: typeof fetch = fetch,
): Promise<ParaswapQuote> {
  const url =
    `https://apiv5.paraswap.io/prices/?srcToken=${fromToken}&destToken=${toToken}` +
    `&amount=${amountRaw}&srcDecimals=${srcDecimals}&destDecimals=${destDecimals}&network=${chainId}&side=SELL`;
  const data = (await fetchJson(url, fetchFn)) as { priceRoute?: { srcAmount?: string; destAmount?: string } };
  const pr = data.priceRoute;
  if (!pr?.srcAmount || !pr?.destAmount) throw new Error("Paraswap tidak mengembalikan quote (pair mungkin tidak ada likuiditas).");
  return { srcAmount: pr.srcAmount, destAmount: pr.destAmount, priceRoute: pr };
}

export interface ParaswapBuild {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gas: string;
}

export async function paraswapBuild(
  chainId: string,
  quote: ParaswapQuote,
  fromToken: string,
  toToken: string,
  userAddress: string,
  slippageBps: number,
  fetchFn: typeof fetch = fetch,
): Promise<ParaswapBuild> {
  const body = {
    priceRoute: quote.priceRoute,
    srcToken: fromToken,
    destToken: toToken,
    srcAmount: quote.srcAmount,
    userAddress,
    receiver: userAddress,
    slippage: slippageBps,
  };
  const data = (await fetchJson(`https://apiv5.paraswap.io/transactions/${chainId}`, fetchFn, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as { to?: string; data?: string; value?: string; chainId?: number; gas?: string; error?: string };
  if (data.error) throw new Error(`Paraswap build gagal: ${data.error}`);
  if (!data.to || !data.data) throw new Error("Paraswap build tidak mengembalikan transaksi.");
  return { to: data.to, data: data.data, value: String(data.value ?? "0"), chainId: data.chainId ?? Number(chainId), gas: String(data.gas ?? "") };
}

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
}

export async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number,
  fetchFn: typeof fetch = fetch,
): Promise<JupiterQuote> {
  const url =
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const data = (await fetchJson(url, fetchFn)) as {
    inAmount?: string;
    outAmount?: string;
    otherAmountThreshold?: string;
    priceImpactPct?: string;
  };
  if (!data.outAmount) throw new Error("Jupiter tidak mengembalikan quote (pair mungkin tidak ada likuiditas).");
  return {
    inAmount: data.inAmount ?? amountRaw,
    outAmount: data.outAmount,
    otherAmountThreshold: data.otherAmountThreshold ?? "0",
    priceImpactPct: data.priceImpactPct ?? "?",
  };
}

// Minimal EVM read surface the swap flow needs, injectable for tests.
export interface EvmRpcCalls {
  getChainId(): Promise<number>;
  getDecimals(token: string): Promise<number>;
  getAllowance(token: string, owner: string, spender: string): Promise<bigint>;
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export async function viemEvmRpcCalls(rpcUrl: string): Promise<EvmRpcCalls> {
  const client = await evmPublicClient(rpcUrl);
  return {
    getChainId: () => client.getChainId(),
    getDecimals: async (token: string) => {
      const res = (await client.call({ to: token as `0x${string}`, data: "0x313ce567" as `0x${string}` })) as { data?: string };
      const hex = (res.data ?? "0x").replace(/^0x/, "");
      return Number(BigInt("0x" + (hex.slice(-2) || "00")));
    },
    getAllowance: async (token: string, owner: string, spender: string) => {
      const data = ("0xdd62ed3e" + padAddress(owner) + padAddress(spender)) as `0x${string}`;
      const res = (await client.call({ to: token as `0x${string}`, data })) as { data?: string };
      return BigInt((res.data ?? "0x0") as string);
    },
  };
}

export interface EvmSwapPrepared {
  kind: "confirmation";
  wallet: string;
  chainId: string;
  rpcUrl: string;
  fromToken: string;
  toToken: string;
  amountIn: string;
  amountOut: string;
  minOut: string;
  router: string;
  gas: string;
  confirmationId: string;
  note: string;
}

export interface EvmSwapNeedsApproval {
  kind: "needsApproval";
  wallet: string;
  chainId: string;
  token: string;
  spender: string;
  amountRaw: string;
  approveData: string;
  note: string;
}

export async function prepareEvmSwap(opts: {
  wallet: string;
  chainId: string;
  fromToken: string;
  toToken: string;
  amount: string;
  slippageBps?: number;
  fetchFn?: typeof fetch;
  rpcCalls?: EvmRpcCalls;
}): Promise<{ ok: boolean; data?: EvmSwapPrepared | EvmSwapNeedsApproval; error?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const slippageBps = opts.slippageBps ?? 100;
  if (slippageBps < 1 || slippageBps > 5000) return { ok: false, error: "Slippage harus 1–5000 bps (0,01%–50%)." };
  if (!PARASWAP_CHAINS.has(opts.chainId)) {
    return { ok: false, error: `Paraswap belum mendukung chainId ${opts.chainId} di alur ini (didukung: ${[...PARASWAP_CHAINS].join(", ")}).` };
  }
  const fromToken = normalizeEvmToken(opts.fromToken);
  const toToken = normalizeEvmToken(opts.toToken);
  if (!fromToken || !toToken) return { ok: false, error: "Token harus alamat 0x… atau 'native'." };
  const record = walletRegistryLoad().find((w) => w.name === opts.wallet);
  if (!record) return { ok: false, error: `Dompet tidak ditemukan: ${opts.wallet}` };
  const rpcUrl = resolveRpc(opts.chainId);
  if (!rpcUrl) return { ok: false, error: `Tidak ada RPC untuk chain ${opts.chainId} (tambah dari dashboard).` };
  try {
    const rpc = opts.rpcCalls ?? (await viemEvmRpcCalls(rpcUrl));
    const liveChainId = await rpc.getChainId();
    if (String(liveChainId) !== opts.chainId) {
      return { ok: false, error: `RPC tidak sesuai rantai: diminta ${opts.chainId}, RPC menjawab ${liveChainId}. Ganti default RPC dari dashboard.` };
    }
    const srcDecimals = fromToken === NATIVE_TOKEN ? 18 : await rpc.getDecimals(fromToken);
    const destDecimals = toToken === NATIVE_TOKEN ? 18 : await rpc.getDecimals(toToken);
    const amountRaw = parseHumanAmount(opts.amount, srcDecimals);
    if (amountRaw === undefined) return { ok: false, error: `Jumlah tidak valid: ${opts.amount}` };
    const quote = await paraswapQuote(opts.chainId, fromToken, toToken, amountRaw.toString(), srcDecimals, destDecimals, fetchFn);
    const build = await paraswapBuild(opts.chainId, quote, fromToken, toToken, record.address, slippageBps, fetchFn);
    const amountOutHuman = formatUnits(quote.destAmount, destDecimals);
    const minOutHuman = formatUnits(minOutRaw(quote.destAmount, slippageBps), destDecimals);
    const note =
      `Swap ${opts.amount} (${fromToken === NATIVE_TOKEN ? "native" : fromToken}) -> ~${amountOutHuman} ` +
      `(min ${minOutHuman} setelah slippage ${slippageBps / 100}%, Paraswap, router ${build.to})`;
    if (fromToken !== NATIVE_TOKEN) {
      const allowance = await rpc.getAllowance(fromToken, record.address, build.to);
      if (allowance < amountRaw) {
        const approveData = ("0x095ea7b3" + padAddress(build.to) + amountRaw.toString(16).padStart(64, "0")) as string;
        return {
          ok: true,
          data: {
            kind: "needsApproval",
            wallet: opts.wallet,
            chainId: opts.chainId,
            token: fromToken,
            spender: build.to,
            amountRaw: amountRaw.toString(),
            approveData,
            note: `${note} — BUTUH APPROVAL dulu: allowance ke router ${allowance} < ${amountRaw}. Konfirmasi approval (approve router, jumlah persis) lalu ulangi swap.`,
          },
        };
      }
    }
    const tx: TxRequest = {
      chain: "evm",
      from: opts.wallet,
      to: build.to,
      value: fromToken === NATIVE_TOKEN ? opts.amount : "0",
      data: build.data,
      gasLimit: build.gas || undefined,
      chainId: liveChainId,
      rpcUrl,
      note,
    };
    const policy = getPolicy();
    const spentToday = getSpentToday(opts.wallet, "evm");
    const conf = await requestConfirmation(tx, policy, { spentToday, isTestnet: isTestnetChainId(liveChainId) });
    if (!conf.policyCheck.ok) return { ok: false, error: `Swap ditolak policy: ${conf.policyCheck.error}` };
    return {
      ok: true,
      data: {
        kind: "confirmation",
        wallet: opts.wallet,
        chainId: opts.chainId,
        rpcUrl,
        fromToken,
        toToken,
        amountIn: opts.amount,
        amountOut: amountOutHuman,
        minOut: minOutHuman,
        router: build.to,
        gas: build.gas,
        confirmationId: conf.id,
        note,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function prepareSolanaSwap(opts: {
  inputMint: string;
  outputMint: string;
  amount: string;
  inputDecimals: number;
  slippageBps?: number;
  fetchFn?: typeof fetch;
}): Promise<{ ok: boolean; data?: { quote: JupiterQuote; execution: string }; error?: string }> {
  const slippageBps = opts.slippageBps ?? 100;
  const amountRaw = parseHumanAmount(opts.amount, opts.inputDecimals);
  if (amountRaw === undefined) return { ok: false, error: `Jumlah tidak valid: ${opts.amount}` };
  try {
    const quote = await jupiterQuote(opts.inputMint, opts.outputMint, amountRaw.toString(), slippageBps, opts.fetchFn ?? fetch);
    return {
      ok: true,
      data: {
        quote,
        execution: "BELUM DIDUKUNG: PansaAgent belum punya jalur sign/broadcast Solana, jadi swap Solana berhenti di quote. Jangan eksekusi manual dari quote ini tanpa verifikasi.",
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
