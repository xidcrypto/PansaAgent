// Custom LLM providers for PANSA (PansaAgent-native, separate from the
// keyless bansos daemon). A provider is an OpenAI-compatible endpoint
// (baseUrl + optional API key + model ids). The key NEVER lives in the
// config file: it is stored encrypted in the secrets store under
// `provider:<id>:apiKey` and is never returned by any list/read call.

import { loadConfig, saveConfig } from "../config.js";
import { secretsLoad, secretsSave, secretsSet } from "../secrets.js";

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
}

export interface CustomProviderView {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  hasKey: boolean;
}

export interface ProviderInput {
  name: string;
  baseUrl: string;
  models?: string[];
  enabled?: boolean;
  /** Plaintext key, only accepted when a passphrase is available. */
  apiKey?: string;
  /** When true, delete the stored key (update only). */
  clearKey?: boolean;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "provider";
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl harus http:// atau https://");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeModels(models: unknown): string[] {
  const list = Array.isArray(models)
    ? models
    : typeof models === "string"
      ? models.split(",")
      : [];
  const out: string[] = [];
  for (const m of list) {
    const id = String(m).trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function secretKey(id: string): string {
  return `provider:${id}:apiKey`;
}

function hasStoredKey(id: string, passphrase?: string): boolean {
  if (!passphrase) return false;
  try {
    const store = secretsLoad(passphrase);
    return typeof store[secretKey(id)] === "string" && store[secretKey(id)].length > 0;
  } catch {
    return false;
  }
}

function storeKey(id: string, apiKey: string, passphrase?: string): void {
  if (!passphrase) {
    throw new Error(
      "PANSA_PASSPHRASE tidak diset di proses ini — kunci provider tidak bisa disimpan terenkripsi. Jalankan dengan passphrase atau buat provider tanpa kunci.",
    );
  }
  const store = secretsLoad(passphrase);
  secretsSet(store, secretKey(id), apiKey);
  secretsSave(store, passphrase);
}

function deleteStoredKey(id: string, passphrase?: string): void {
  if (!passphrase) return;
  try {
    const store = secretsLoad(passphrase);
    if (secretKey(id) in store) {
      delete store[secretKey(id)];
      secretsSave(store, passphrase);
    }
  } catch {
    // Best effort: a missing/unreadable store means no key to delete.
  }
}

export function listProviders(passphrase?: string): CustomProviderView[] {
  const cfg = loadConfig();
  return (cfg.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: [...p.models],
    enabled: p.enabled,
    hasKey: hasStoredKey(p.id, passphrase),
  }));
}

export function getProvider(id: string, passphrase?: string): CustomProviderView | undefined {
  return listProviders(passphrase).find((p) => p.id === id);
}

export function createProvider(input: ProviderInput, passphrase?: string): CustomProviderView {
  const name = input.name?.trim();
  if (!name) throw new Error("Nama provider wajib diisi.");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const models = normalizeModels(input.models);
  if (!models.length) throw new Error("Minimal satu model wajib diisi.");
  if (input.apiKey !== undefined && input.apiKey !== "" && !passphrase) {
    throw new Error(
      "PANSA_PASSPHRASE tidak diset di proses ini — kunci provider tidak bisa disimpan terenkripsi.",
    );
  }
  const cfg = loadConfig();
  const providers = [...(cfg.providers ?? [])];
  let id = slugify(name);
  if (providers.some((p) => p.id === id)) {
    let n = 2;
    while (providers.some((p) => p.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const provider: CustomProviderConfig = {
    id,
    name,
    baseUrl,
    models,
    enabled: input.enabled ?? true,
  };
  providers.push(provider);
  saveConfig({ ...cfg, providers });
  if (input.apiKey) storeKey(id, input.apiKey, passphrase);
  return { ...provider, hasKey: Boolean(input.apiKey) };
}

export function updateProvider(
  id: string,
  patch: Partial<ProviderInput>,
  passphrase?: string,
): CustomProviderView {
  const cfg = loadConfig();
  const providers = [...(cfg.providers ?? [])];
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Provider tidak ditemukan: ${id}`);
  const current = providers[idx]!;
  if (patch.name !== undefined && !patch.name.trim()) throw new Error("Nama provider tidak boleh kosong.");
  const next: CustomProviderConfig = {
    ...current,
    name: patch.name?.trim() ?? current.name,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    models: patch.models !== undefined ? normalizeModels(patch.models) : current.models,
    enabled: patch.enabled ?? current.enabled,
  };
  if (!next.models.length) throw new Error("Minimal satu model wajib diisi.");
  if (patch.apiKey !== undefined && patch.apiKey !== "" && !passphrase) {
    throw new Error(
      "PANSA_PASSPHRASE tidak diset di proses ini — kunci provider tidak bisa disimpan terenkripsi.",
    );
  }
  providers[idx] = next;
  saveConfig({ ...cfg, providers });
  if (patch.clearKey) deleteStoredKey(id, passphrase);
  else if (patch.apiKey) storeKey(id, patch.apiKey, passphrase);
  return { ...next, hasKey: patch.clearKey ? false : patch.apiKey ? true : hasStoredKey(id, passphrase) };
}

export function deleteProvider(id: string, passphrase?: string): void {
  const cfg = loadConfig();
  const providers = (cfg.providers ?? []).filter((p) => p.id !== id);
  if (providers.length === (cfg.providers ?? []).length) throw new Error(`Provider tidak ditemukan: ${id}`);
  saveConfig({ ...cfg, providers });
  deleteStoredKey(id, passphrase);
}

/** Decrypt a provider's key. Throws when missing/unreadable — callers
 *  must treat that as "provider unavailable" and fail over, never crash. */
export function getProviderKey(id: string, passphrase?: string): string | undefined {
  if (!passphrase) return undefined;
  try {
    const store = secretsLoad(passphrase);
    const value = store[secretKey(id)];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Find the enabled custom provider serving a model id, if any. */
export function findCustomProvider(
  model: string,
  providers?: CustomProviderConfig[],
): CustomProviderConfig | undefined {
  return (providers ?? []).find((p) => p.enabled && p.models.includes(model));
}

export interface ProviderTestResult {
  ok: boolean;
  count?: number;
  sample?: string[];
  error?: string;
}

/** Probe a provider's /v1/models endpoint (OpenAI-compatible). Never
 *  logs or returns the key; only counts and sample ids come back. */
export async function testProvider(
  provider: CustomProviderConfig,
  apiKey?: string,
): Promise<ProviderTestResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/models`, {
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = Array.isArray(json.data)
      ? json.data.map((d) => d.id).filter((id): id is string => typeof id === "string")
      : [];
    return { ok: true, count: ids.length, sample: ids.slice(0, 10) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function testProviderById(
  id: string,
  passphrase?: string,
): Promise<ProviderTestResult> {
  const cfg = loadConfig();
  const provider = (cfg.providers ?? []).find((p) => p.id === id);
  if (!provider) return { ok: false, error: `Provider tidak ditemukan: ${id}` };
  if (!provider.enabled) return { ok: false, error: "Provider nonaktif." };
  return testProvider(provider, getProviderKey(id, passphrase));
}
