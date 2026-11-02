import { keystoreRead, keystoreUnlock, walletRegistryLoad, ChainFamily } from "./keystore.js";
import { evmAccountFromMnemonic } from "./evm.js";
import { PANSA_DIR } from "../config.js";
import { resolveEvmRpc, evmPublicClient, isTestnetChainId } from "../evm-rpc.js";
import { existsSync, readFileSync } from "node:fs";
import { loadViem, loadViemAccounts } from "../viem-lazy.js";
import { randomUUID } from "node:crypto";

const UNLOCK_TTL_MS = 15 * 60 * 1000;
const UNLOCKED = new Map<string, { family: ChainFamily; mnemonic: string; path: string; expiresAt: number }>();

export interface TxRequest {
  chain: ChainFamily;
  // Wallet NAME (as in the keystore) for sign flows, or an address for
  // direct simulation. The broadcast path resolves names via the registry.
  from: string;
  to: string;
  value?: string;
  data?: string;
  nonce?: number;
  gasLimit?: string;
  gasPrice?: string;
  // Resolved EVM chain id (required for real signing). Filled in by the
  // sign flow from the RPC endpoint; never guessed.
  chainId?: number;
  rpcUrl?: string;
}

export interface TxSimulation {
  ok: boolean;
  gasUsed?: string;
  success?: boolean;
  error?: string;
  balanceChange?: string;
}

export interface PolicyConfig {
  spendCapPerTx: number;
  spendCapPerDay: number;
  allowedChains: ChainFamily[];
  requireConfirmation: boolean;
  testnetOnly: boolean;
}

const DEFAULT_POLICY: PolicyConfig = {
  spendCapPerTx: 0.01,
  spendCapPerDay: 0.05,
  allowedChains: ["evm", "solana", "sui", "aptos"],
  requireConfirmation: true,
  testnetOnly: true,
};

const FAMILIES: ChainFamily[] = ["evm", "solana", "sui", "aptos"];

// Validate a policy object field-by-field, failing closed to the safe
// default for every invalid field (M9). Never throws on malformed input.
export function validatePolicy(data: unknown): PolicyConfig {
  const out = { ...DEFAULT_POLICY };
  if (typeof data !== "object" || data === null) return out;
  const d = data as Record<string, unknown>;
  if (typeof d.spendCapPerTx === "number" && Number.isFinite(d.spendCapPerTx) && d.spendCapPerTx >= 0) {
    out.spendCapPerTx = d.spendCapPerTx;
  }
  if (typeof d.spendCapPerDay === "number" && Number.isFinite(d.spendCapPerDay) && d.spendCapPerDay >= 0) {
    out.spendCapPerDay = d.spendCapPerDay;
  }
  if (Array.isArray(d.allowedChains) && d.allowedChains.length > 0 && d.allowedChains.every((c) => FAMILIES.includes(c as ChainFamily))) {
    out.allowedChains = d.allowedChains as ChainFamily[];
  }
  if (typeof d.requireConfirmation === "boolean") out.requireConfirmation = d.requireConfirmation;
  if (typeof d.testnetOnly === "boolean") out.testnetOnly = d.testnetOnly;
  return out;
}

export function loadPolicy(): PolicyConfig {
  const policyFile = `${PANSA_DIR}/policy.json`;
  if (!existsSync(policyFile)) return { ...DEFAULT_POLICY };
  try {
    const data = JSON.parse(readFileSync(policyFile, "utf8"));
    return validatePolicy(data);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export interface PolicyCheckOptions {
  // Already-spent amount for this wallet+chain today (from the ledger).
  spentToday?: number;
  // Whether the target network was verified as a testnet. Undefined means
  // "could not verify" and fails closed under a testnet-only policy.
  isTestnet?: boolean;
}

export function parseTxValue(tx: TxRequest): { ok: boolean; value?: number; error?: string } {
  if (tx.value === undefined || tx.value === "") return { ok: true, value: 0 };
  const v = parseFloat(tx.value);
  if (!Number.isFinite(v)) return { ok: false, error: `Invalid value: ${tx.value} (not a number)` };
  if (v < 0) return { ok: false, error: `Invalid value: ${tx.value} (negative)` };
  return { ok: true, value: v };
}

export function checkPolicy(tx: TxRequest, policy: PolicyConfig, opts: PolicyCheckOptions = {}): { ok: boolean; error?: string } {
  if (!policy.allowedChains.includes(tx.chain)) {
    return { ok: false, error: `Chain ${tx.chain} not in allowed list` };
  }
  const parsed = parseTxValue(tx);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const valueEth = parsed.value ?? 0;
  if (valueEth > policy.spendCapPerTx) {
    return { ok: false, error: `Value ${valueEth} exceeds per-tx cap ${policy.spendCapPerTx}` };
  }
  const spentToday = opts.spentToday ?? 0;
  if (spentToday + valueEth > policy.spendCapPerDay) {
    return { ok: false, error: `Value ${valueEth} plus spent today ${spentToday} exceeds daily cap ${policy.spendCapPerDay}` };
  }
  if (policy.testnetOnly) {
    if (opts.isTestnet === undefined) {
      return { ok: false, error: "Cannot verify testnet (no chain id resolved); refusing under testnet-only policy" };
    }
    if (!opts.isTestnet) {
      return { ok: false, error: "Policy requires testnet only" };
    }
  }
  return { ok: true };
}

// Resolve the from field to an address: a 0x address passes through, a
// wallet name resolves via the public registry.
function resolveFromAddress(from: string): string | undefined {
  if (/^0x[0-9a-fA-F]{40}$/.test(from)) return from;
  const record = walletRegistryLoad().find((w) => w.name === from);
  return record?.address;
}

export async function simulateTx(tx: TxRequest): Promise<TxSimulation> {
  if (tx.chain !== "evm") {
    return { ok: false, error: `Simulation not supported for chain ${tx.chain}` };
  }
  const rpcUrl = tx.rpcUrl ?? resolveEvmRpc();
  if (!rpcUrl) {
    return { ok: false, error: "Simulation unavailable: no EVM RPC configured (set PANSA_EVM_RPC or evmRpc in config)" };
  }
  const fromAddress = resolveFromAddress(tx.from);
  if (!fromAddress) {
    return { ok: false, error: `Unknown wallet or address: ${tx.from}` };
  }
  try {
    const client = await evmPublicClient(rpcUrl);
    const { parseEther } = await loadViem();
    const value = tx.value ? parseEther(tx.value) : 0n;
    await client.call({
      account: fromAddress as `0x${string}`,
      to: tx.to as `0x${string}`,
      value,
      data: tx.data as `0x${string}` | undefined,
    });
    const gas = await client.estimateGas({
      account: fromAddress as `0x${string}`,
      to: tx.to as `0x${string}`,
      value,
      data: tx.data as `0x${string}` | undefined,
    });
    return { ok: true, gasUsed: gas.toString(), success: true, balanceChange: tx.value ?? "0" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function unlockWallet(name: string, passphrase: string): { family: ChainFamily; mnemonic: string; path: string } {
  const entry = keystoreRead(name);
  UNLOCKED.set(name, { family: entry.family, mnemonic: "", path: entry.path, expiresAt: Date.now() + UNLOCK_TTL_MS });
  const payload = keystoreUnlock(name, passphrase);
  UNLOCKED.set(name, { family: entry.family, mnemonic: payload.mnemonic, path: payload.path, expiresAt: Date.now() + UNLOCK_TTL_MS });
  return payload;
}

export function getUnlocked(name: string): { family: ChainFamily; mnemonic: string; path: string } | undefined {
  const e = UNLOCKED.get(name);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    UNLOCKED.delete(name);
    return undefined;
  }
  return { family: e.family, mnemonic: e.mnemonic, path: e.path };
}

export function lockWallet(name: string): void {
  UNLOCKED.delete(name);
}

export function clearAllUnlocked(): void {
  UNLOCKED.clear();
}

// Real offline EVM signing with viem (B5). Returns the RLP-encoded signed
// transaction and its keccak hash. Nothing is broadcast here; broadcast
// happens only in the human-confirmed execute path.
export async function signEvmTx(tx: TxRequest, mnemonic: string, path: string): Promise<{ signedTx: string; hash: string }> {
  if (tx.chain !== "evm") throw new Error("signEvmTx only supports evm");
  if (tx.chainId === undefined) throw new Error("chainId required to sign (resolve it from the RPC endpoint first)");
  const { privateKey } = evmAccountFromMnemonic(mnemonic, path);
  const { privateKeyToAccount } = await loadViemAccounts();
  const { parseEther, parseGwei, keccak256 } = await loadViem();
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const value = tx.value ? parseEther(tx.value) : 0n;
  // Gas is never guessed for contract calls: a plain transfer costs 21000
  // by protocol, but a call needs an explicit limit (or an estimate from
  // the execute path). Defaulting a call to 21000 would sign a tx that
  // cannot execute.
  let gas: bigint;
  if (tx.gasLimit) gas = BigInt(tx.gasLimit);
  else if (!tx.data) gas = 21000n;
  else throw new Error("gasLimit required for contract calls (no default for data-carrying transactions)");
  const signed = await account.signTransaction({
    to: tx.to as `0x${string}`,
    value,
    data: tx.data as `0x${string}` | undefined,
    chainId: tx.chainId,
    nonce: tx.nonce ?? 0,
    gas,
    gasPrice: tx.gasPrice ? parseGwei(tx.gasPrice) : 0n,
  });
  return { signedTx: signed, hash: keccak256(signed as `0x${string}`) };
}

export function generateConfirmationId(): string {
  return `conf_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export { isTestnetChainId };
