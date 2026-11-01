import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const PANSA_DIR = `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.pansa`;
export const CONFIG_FILE = `${PANSA_DIR}/config.json`;
export const POLICY_FILE = `${PANSA_DIR}/policy.json`;
export const KEYSTORE_DIR = `${PANSA_DIR}/keystore`;
export const WALLETS_FILE = `${PANSA_DIR}/wallets.json`;
export const SECRETS_FILE = `${PANSA_DIR}/secrets.json`;
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

export interface PolicyConfig {
  defaultDeny: boolean;
  testnetOnly: boolean;
  mainnetEnabled: boolean;
  chains: Record<string, ChainConfig>;
}

export interface GatewayConfig {
  enabled: boolean;
  adapter: string;
  allowlist: string[];
  features: string[];
}

export interface PansaConfig {
  models?: string[];
  preferReasoning?: string[];
  preferCheap?: string[];
  concurrency?: number;
  ttlMs?: number;
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
    defaultDeny: true,
    testnetOnly: true,
    mainnetEnabled: false,
    chains: {
      evm: { enabled: true, testnetOnly: true, maxNativePerTx: "0.01", maxNativePerDay: "0.05" },
      solana: { enabled: true, testnetOnly: true, maxNativePerTx: "0.01", maxNativePerDay: "0.05" },
      sui: { enabled: true, testnetOnly: true, maxNativePerTx: "0.01", maxNativePerDay: "0.05" },
      aptos: { enabled: true, testnetOnly: true, maxNativePerTx: "0.01", maxNativePerDay: "0.05" },
    },
  };
}
