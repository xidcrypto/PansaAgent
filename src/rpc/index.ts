// RPC registry: built-in public endpoints per chain + user customs from
// the dashboard. A chain's effective default is ONLY what the user (or
// legacy config) set: dashboard default > legacy single-RPC field
// (evmRpc/solanaRpc). Built-ins are selectable candidates, never an
// implicit default — no endpoint means no feature for that chain
// (fail-closed, same rule the EVM resolver always had). Env overrides
// (PANSA_EVM_RPC, PANSA_SOLANA_RPC) always win at resolve time and are
// never stored.
import { loadConfig, saveConfig, type PansaConfig } from "../config.js";
import { randomUUID } from "node:crypto";

export const CHAIN_NAMES: Record<string, string> = {
  "1": "Ethereum",
  "56": "BNB Smart Chain",
  "137": "Polygon",
  "42161": "Arbitrum One",
  "10": "Optimism",
  "8453": "Base",
  "43114": "Avalanche C-Chain",
  solana: "Solana",
  sui: "Sui",
  aptos: "Aptos",
};

export const CHAIN_ALIASES: Record<string, string> = {
  eth: "1",
  ethereum: "1",
  bsc: "56",
  bnb: "56",
  polygon: "137",
  matic: "137",
  arbitrum: "42161",
  arb: "42161",
  optimism: "10",
  op: "10",
  base: "8453",
  avalanche: "43114",
  avax: "43114",
};

export function normalizeChainKey(input: string): string | undefined {
  const t = input.trim().toLowerCase();
  if (CHAIN_NAMES[t]) return t;
  if (CHAIN_ALIASES[t]) return CHAIN_ALIASES[t];
  if (/^\d+$/.test(t) && CHAIN_NAMES[t]) return t;
  return undefined;
}

export function isEvmChainKey(chain: string): boolean {
  return /^\d+$/.test(chain);
}

export interface BuiltinRpc {
  chain: string;
  name: string;
  url: string;
}

const BUILTINS: BuiltinRpc[] = [
  { chain: "1", name: "LlamaRPC", url: "https://eth.llamarpc.com" },
  { chain: "1", name: "PublicNode", url: "https://ethereum.publicnode.com" },
  { chain: "1", name: "Ankr", url: "https://rpc.ankr.com/eth" },
  { chain: "1", name: "Cloudflare", url: "https://cloudflare-eth.com" },
  { chain: "56", name: "BNB Dataseed", url: "https://bsc-dataseed.bnbchain.org" },
  { chain: "56", name: "BNB Dataseed 1", url: "https://bsc-dataseed1.bnbchain.org" },
  { chain: "56", name: "Defibit", url: "https://bsc-dataseed1.defibit.io" },
  { chain: "56", name: "PublicNode", url: "https://bsc-rpc.publicnode.com" },
  { chain: "137", name: "Polygon RPC", url: "https://polygon-rpc.com" },
  { chain: "137", name: "LlamaRPC", url: "https://polygon.llamarpc.com" },
  { chain: "137", name: "Ankr", url: "https://rpc.ankr.com/polygon" },
  { chain: "42161", name: "Arbitrum One", url: "https://arb1.arbitrum.io/rpc" },
  { chain: "42161", name: "LlamaRPC", url: "https://arbitrum.llamarpc.com" },
  { chain: "10", name: "Optimism", url: "https://mainnet.optimism.io" },
  { chain: "10", name: "LlamaRPC", url: "https://optimism.llamarpc.com" },
  { chain: "8453", name: "Base", url: "https://mainnet.base.org" },
  { chain: "8453", name: "LlamaRPC", url: "https://base.llamarpc.com" },
  { chain: "43114", name: "Avalanche C-Chain", url: "https://api.avax.network/ext/bc/C/rpc" },
  { chain: "43114", name: "PublicNode", url: "https://avalanche-c-chain.publicnode.com" },
  { chain: "solana", name: "Mainnet Beta", url: "https://api.mainnet-beta.solana.com" },
  { chain: "solana", name: "PublicNode", url: "https://solana-rpc.publicnode.com" },
  { chain: "sui", name: "Sui Fullnode", url: "https://fullnode.mainnet.sui.io:443" },
  { chain: "aptos", name: "Aptos Fullnode", url: "https://fullnode.mainnet.aptoslabs.com/v1" },
];

export function builtinRpcs(chain?: string): BuiltinRpc[] {
  return chain ? BUILTINS.filter((b) => b.chain === chain) : [...BUILTINS];
}

export interface RpcCustom {
  id: string;
  chain: string;
  name: string;
  url: string;
}

export interface RpcEntry {
  id: string;
  chain: string;
  name: string;
  url: string;
  builtin: boolean;
  isDefault: boolean;
}

export function builtinId(b: BuiltinRpc): string {
  const idx = BUILTINS.indexOf(b);
  return `builtin-${b.chain}-${idx}`;
}

function rpcStore(cfg: PansaConfig): { defaults: Record<string, string>; custom: RpcCustom[] } {
  const r = cfg.rpcs ?? {};
  return { defaults: { ...(r.defaults ?? {}) }, custom: [...(r.custom ?? [])] };
}

function saveStore(cfg: PansaConfig, store: { defaults: Record<string, string>; custom: RpcCustom[] }): void {
  cfg.rpcs = store;
  saveConfig(cfg);
}

// Effective default URL for a chain: dashboard default > legacy single-RPC
// field. Built-ins are NOT an implicit default: unknown chains and
// chains with no user choice have no default (fail-closed).
export function effectiveDefault(chain: string, cfg: PansaConfig = loadConfig()): string | undefined {
  const store = rpcStore(cfg);
  if (store.defaults[chain]) return store.defaults[chain];
  if (isEvmChainKey(chain) && cfg.evmRpc) return cfg.evmRpc;
  if (chain === "solana" && cfg.solanaRpc) return cfg.solanaRpc;
  return undefined;
}

export function listRpcs(chain: string, cfg: PansaConfig = loadConfig()): RpcEntry[] {
  const def = effectiveDefault(chain, cfg);
  const store = rpcStore(cfg);
  const out: RpcEntry[] = BUILTINS.filter((b) => b.chain === chain).map((b) => ({
    id: builtinId(b),
    chain: b.chain,
    name: b.name,
    url: b.url,
    builtin: true,
    isDefault: b.url === def,
  }));
  for (const c of store.custom.filter((c) => c.chain === chain)) {
    out.push({ ...c, builtin: false, isDefault: c.url === def });
  }
  return out;
}

// Resolve the RPC to actually use: explicit arg > env override > chain
// default. Env overrides are per family (PANSA_EVM_RPC covers all EVM
// chains, PANSA_SOLANA_RPC covers Solana); sui/aptos have no env var.
export function resolveRpc(chain: string, explicit?: string, cfg: PansaConfig = loadConfig()): string | undefined {
  if (explicit) return explicit;
  if (isEvmChainKey(chain) && process.env.PANSA_EVM_RPC) return process.env.PANSA_EVM_RPC;
  if (chain === "solana" && process.env.PANSA_SOLANA_RPC) return process.env.PANSA_SOLANA_RPC;
  return effectiveDefault(chain, cfg);
}

function validateUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "URL RPC harus http(s).";
    return undefined;
  } catch {
    return "URL RPC tidak valid.";
  }
}

export function addCustomRpc(
  chainInput: string,
  name: string,
  url: string,
  cfg: PansaConfig = loadConfig(),
): { ok: boolean; entry?: RpcCustom; error?: string } {
  const chain = normalizeChainKey(chainInput);
  if (!chain) return { ok: false, error: `Rantai tidak dikenal: ${chainInput}. Pakai chainId (56) atau nama (bsc, solana).` };
  if (!name.trim()) return { ok: false, error: "Nama RPC wajib diisi." };
  const urlErr = validateUrl(url);
  if (urlErr) return { ok: false, error: urlErr };
  const store = rpcStore(cfg);
  if (listRpcs(chain, cfg).some((e) => e.url === url)) {
    return { ok: false, error: `URL sudah ada di daftar ${CHAIN_NAMES[chain]}.` };
  }
  const entry: RpcCustom = { id: `rpc_${randomUUID().slice(0, 8)}`, chain, name: name.trim(), url };
  store.custom.push(entry);
  saveStore(cfg, store);
  return { ok: true, entry };
}

export function removeCustomRpc(id: string, cfg: PansaConfig = loadConfig()): { ok: boolean; error?: string } {
  const store = rpcStore(cfg);
  const idx = store.custom.findIndex((c) => c.id === id);
  if (idx === -1) {
    if (id.startsWith("builtin-")) return { ok: false, error: "RPC bawaan tidak bisa dihapus (pilih default lain bila perlu)." };
    return { ok: false, error: `RPC tidak ditemukan: ${id}` };
  }
  const [removed] = store.custom.splice(idx, 1);
  if (store.defaults[removed.chain] === removed.url) delete store.defaults[removed.chain];
  saveStore(cfg, store);
  return { ok: true };
}

export function setDefaultRpc(id: string, cfg: PansaConfig = loadConfig()): { ok: boolean; entry?: RpcEntry; error?: string } {
  let found: RpcEntry | undefined;
  for (const chain of Object.keys(CHAIN_NAMES)) {
    found = listRpcs(chain, cfg).find((e) => e.id === id);
    if (found) break;
  }
  if (!found) return { ok: false, error: `RPC tidak ditemukan: ${id}` };
  const store = rpcStore(cfg);
  store.defaults[found.chain] = found.url;
  saveStore(cfg, store);
  return { ok: true, entry: { ...found, isDefault: true } };
}
