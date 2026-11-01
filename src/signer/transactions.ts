import { keystoreRead, keystoreUnlock, ChainFamily } from "./keystore.js";
import { evmAccountFromMnemonic } from "./evm.js";
import { PANSA_DIR } from "../config.js";
import { existsSync, readFileSync } from "node:fs";

const UNLOCKED = new Map<string, { family: ChainFamily; mnemonic: string; path: string }>();

export interface TxRequest {
  chain: ChainFamily;
  from: string;
  to: string;
  value?: string;
  data?: string;
  nonce?: number;
  gasLimit?: string;
  gasPrice?: string;
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

export function loadPolicy(): PolicyConfig {
  const policyFile = `${PANSA_DIR}/policy.json`;
  if (!existsSync(policyFile)) return DEFAULT_POLICY;
  try {
    const data = JSON.parse(readFileSync(policyFile, "utf8"));
    return { ...DEFAULT_POLICY, ...data };
  } catch {
    return DEFAULT_POLICY;
  }
}

export function checkPolicy(tx: TxRequest, policy: PolicyConfig): { ok: boolean; error?: string } {
  if (!policy.allowedChains.includes(tx.chain)) {
    return { ok: false, error: `Chain ${tx.chain} not in allowed list` };
  }
  if (policy.testnetOnly && !isTestnet(tx.chain)) {
    return { ok: false, error: "Policy requires testnet only" };
  }
  const valueEth = tx.value ? parseFloat(tx.value) : 0;
  if (valueEth > policy.spendCapPerTx) {
    return { ok: false, error: `Value ${valueEth} exceeds per-tx cap ${policy.spendCapPerTx}` };
  }
  return { ok: true };
}

function isTestnet(_chain: ChainFamily): boolean {
  // Simplified: in real impl, check RPC endpoint
  return true;
}

export async function simulateTx(tx: TxRequest): Promise<TxSimulation> {
  // Stub simulation - real impl would call RPC eth_call or equivalent
  await new Promise(r => setTimeout(r, 100));
  return {
    ok: true,
    gasUsed: "21000",
    success: true,
    balanceChange: tx.value ?? "0",
  };
}

export function unlockWallet(name: string, passphrase: string): { family: ChainFamily; mnemonic: string; path: string } {
  const entry = keystoreRead(name);
  UNLOCKED.set(name, { family: entry.family, mnemonic: "", path: entry.path });
  const payload = keystoreUnlock(name, passphrase);
  UNLOCKED.set(name, { family: entry.family, mnemonic: payload.mnemonic, path: payload.path });
  return payload;
}

export function getUnlocked(name: string): { family: ChainFamily; mnemonic: string; path: string } | undefined {
  return UNLOCKED.get(name);
}

export function lockWallet(name: string): void {
  UNLOCKED.delete(name);
}

export function clearAllUnlocked(): void {
  UNLOCKED.clear();
}

export async function signEvmTx(tx: TxRequest, mnemonic: string, path: string): Promise<{ signedTx: string; hash: string }> {
  evmAccountFromMnemonic(mnemonic, path);
  // Stub signing - real impl would use viem to sign
  const hash = `0x${Buffer.from(JSON.stringify(tx)).toString("hex").slice(0, 64)}`;
  return {
    signedTx: `signed_${hash}`,
    hash,
  };
}

export function generateConfirmationId(): string {
  return `conf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
