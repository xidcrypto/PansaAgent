import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PolicyConfig as SignerPolicyConfig } from "./signer/transactions.js";

export const PANSA_DIR = `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.pansa`;
export const CONFIG_FILE = `${PANSA_DIR}/config.json`;
export const POLICY_FILE = `${PANSA_DIR}/policy.json`;
export const KEYSTORE_DIR = `${PANSA_DIR}/keystore`;
export const WALLETS_FILE = `${PANSA_DIR}/wallets.json`;
export const SECRETS_FILE = `${PANSA_DIR}/secrets.json`; // Legacy path only: one-time migration source for the SQLite secrets store.
export const DB_FILE = `${PANSA_DIR}/db.sqlite`;

export const REASONING_MODELS = [
  "deepseek-v4-flash-free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nemotron-3-ultra-free",
];
export const CHEAP_MODELS = ["mimo-v2.5-free", "kilo-auto/free"];
export const DEFAULT_MODEL_PREF = [
  "deepseek-v4-flash-free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nemotron-3-ultra-free",
  "mimo-v2.5-free",
  "kilo-auto/free",
];
export const DEFAULT_CONCURRENCY = 6;
export const TTL_MS = 20_000;
export const CONTEXT_BUDGET_CHARS = 4000;
export const MAX_STEPS = 14;

export interface ChainConfig {
  enabled: boolean;
  testnetOnly: boolean;
  maxNativePerTx: string;
  maxNativePerDay: string;
  gasPriceCap?: string;
}

// The canonical policy shape is the signer's (M9). The old config-local
// PolicyConfig (defaultDeny/chains) is retired; anything that read
// config.policy now sees the signer shape, and enforcement always loads
// policy.json through the single loader in signer/transactions.ts.
export type PolicyConfig = SignerPolicyConfig;

export interface GatewayConfig {
  enabled: boolean;
  adapter: string;
  allowlist: string[];
  features: string[];
  // Telegram user IDs that may use the bot WITHOUT pairing: a private
  // message from one of these users is served immediately. Anyone else
  // is ignored silently (pairing codes issued by the owner still work
  // as an enrollment path). Never put secrets here — user IDs are not
  // secret, but they do identify who may access this instance.
  allowedUsers?: number[];
  // Explicit opt-in for the testnet confirm path via the gateway.
  // Mainnet confirmations via the gateway are never allowed.
  confirmTestnet?: boolean;
}

export interface PansaConfig {
  models?: string[];
  preferReasoning?: string[];
  preferCheap?: string[];
  /** Custom OpenAI-compatible providers (keys live in the secrets store,
   *  never here). See src/providers/index.ts. */
  providers?: import("./providers/index.js").CustomProviderConfig[];
  concurrency?: number;
  ttlMs?: number;
  // EVM JSON-RPC endpoint for balance lookup, testnet detection,
  // simulation and broadcast. Env PANSA_EVM_RPC overrides this.
  evmRpc?: string;
  policy?: PolicyConfig;
  gateways?: Record<string, GatewayConfig>;
  mcpServers?: Record<string, string>;
  browser?: boolean;
}

export const DEFAULT_CONFIG: PansaConfig = {
  models: [...DEFAULT_MODEL_PREF],
  concurrency: DEFAULT_CONCURRENCY,
  ttlMs: TTL_MS,
};

export function loadConfig(): PansaConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PansaConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: PansaConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export function modelForTask(
  kind: "reasoning" | "cheap",
  live: string[],
  cfg: PansaConfig,
): string | undefined {
  const reasoning = (cfg.preferReasoning ?? REASONING_MODELS).filter((m) => live.includes(m));
  const cheap = (cfg.preferCheap ?? CHEAP_MODELS).filter((m) => live.includes(m));
  const all = [...reasoning, ...cheap].filter((m) => live.includes(m));
  if (kind === "reasoning") return reasoning[0] ?? all[0];
  return cheap[0] ?? all[0];
}

export function defaultPolicy(): PolicyConfig {
  return {
    spendCapPerTx: 0.01,
    spendCapPerDay: 0.05,
    allowedChains: ["evm", "solana", "sui", "aptos"],
    requireConfirmation: true,
    testnetOnly: true,
  };
}
