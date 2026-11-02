// Custom LLM providers for PANSA (PansaAgent-native, separate from the
// keyless bansos daemon). A provider is an OpenAI-compatible endpoint
// (baseUrl + optional API key + model ids). The key NEVER lives in the
// config file: it is stored encrypted in the secrets store under
// `provider:<id>:apiKey` and is never returned by any list/read call.

import { loadConfig, saveConfig } from "../config.js";
import { secretsLoad, secretsSave, secretsSet, secretsHas } from "../secrets.js";

export type ProviderApi = "openai" | "anthropic";

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** Wire format: OpenAI-compatible (default, legacy) or Anthropic. */
  api?: ProviderApi;
  models: string[];
  /** Model ids from models[] that are switched off. Absent = none off. */
  disabledModels?: string[];
  enabled: boolean;
}

export interface CustomProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  models: string[];
  /** Always present in views, even for legacy configs without the field. */
  disabledModels: string[];
  enabled: boolean;
  hasKey: boolean;
}

export interface ProviderInput {
  name: string;
  baseUrl: string;
  api?: ProviderApi;
  models?: string[];
  /** Model ids to switch off. Only entries also in models survive. */
  disabledModels?: string[];
  enabled?: boolean;
  /** Plaintext key, only accepted when a passphrase is available. */
  apiKey?: string;
  /** When true, delete the stored key (update only). */
  clearKey?: boolean;
}

function normalizeApi(api: unknown): ProviderApi {
  return api === "anthropic" ? "anthropic" : "openai";
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

/** Keep only disabled ids that are actually registered models. */
function normalizeDisabledModels(models: string[], disabled: unknown): string[] {
  const list = Array.isArray(disabled)
    ? disabled
    : typeof disabled === "string"
      ? disabled.split(",")
      : [];
  const out: string[] = [];
  for (const m of list) {
    const id = String(m).trim();
    if (id && models.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function secretKey(id: string): string {
  return `provider:${id}:apiKey`;
}

function hasStoredKey(id: string, passphrase?: string): boolean {
  // Hanya cek keberadaan baris (tanpa dekripsi): listProviders dipanggil
  // setiap polling /api/status (3 detik), dan dekripsi scrypt per nilai
  // membuat status menggantung sampai nginx 504 (10 detik) saat provider
  // dan secret bertambah. Fail-closed tetap: tanpa passphrase -> false.
  if (!passphrase) return false;
  try {
    return secretsHas(secretKey(id));
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
    api: normalizeApi(p.api),
    models: [...p.models],
    disabledModels: normalizeDisabledModels(p.models, p.disabledModels),
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
    api: normalizeApi(input.api),
    models,
    disabledModels: normalizeDisabledModels(models, input.disabledModels),
    enabled: input.enabled ?? true,
  };
  providers.push(provider);
  saveConfig({ ...cfg, providers });
  if (input.apiKey) storeKey(id, input.apiKey, passphrase);
  return { ...provider, api: provider.api ?? "openai", disabledModels: [...(provider.disabledModels ?? [])], hasKey: Boolean(input.apiKey) };
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
  const nextModels = patch.models !== undefined ? normalizeModels(patch.models) : current.models;
  const next: CustomProviderConfig = {
    ...current,
    name: patch.name?.trim() ?? current.name,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    api: patch.api !== undefined ? normalizeApi(patch.api) : normalizeApi(current.api),
    models: nextModels,
    disabledModels:
      patch.disabledModels !== undefined
        ? normalizeDisabledModels(nextModels, patch.disabledModels)
        : normalizeDisabledModels(nextModels, current.disabledModels),
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
  return { ...next, api: next.api ?? "openai", disabledModels: [...(next.disabledModels ?? [])], hasKey: patch.clearKey ? false : patch.apiKey ? true : hasStoredKey(id, passphrase) };
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

/** Find the enabled custom provider serving a model id, if any. A model
 *  switched off in disabledModels is never served, even when registered. */
export function findCustomProvider(
  model: string,
  providers?: CustomProviderConfig[],
): CustomProviderConfig | undefined {
  return (providers ?? []).find(
    (p) => p.enabled && p.models.includes(model) && !(p.disabledModels ?? []).includes(model),
  );
}

/** Switch one registered model on or off without touching the rest. */
export function setModelEnabled(
  id: string,
  model: string,
  enabled: boolean,
  passphrase?: string,
): CustomProviderView {
  const cfg = loadConfig();
  const current = (cfg.providers ?? []).find((p) => p.id === id);
  if (!current) throw new Error(`Provider tidak ditemukan: ${id}`);
  if (!current.models.includes(model)) throw new Error(`Model tidak terdaftar di provider ini: ${model}`);
  const disabled = normalizeDisabledModels(current.models, current.disabledModels);
  const next = enabled ? disabled.filter((m) => m !== model) : [...disabled, model].filter((m, i, a) => a.indexOf(m) === i);
  return updateProvider(id, { disabledModels: next }, passphrase);
}

export interface ProviderTestResult {
  ok: boolean;
  count?: number;
  sample?: string[];
  error?: string;
}

export interface FetchModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

/** Fetch the full model list from a provider endpoint (the Connect and
 *  Test-connection steps). Never logs or returns the key; only ids come
 *  back. OpenAI shape: Bearer auth, {data:[{id}]}. Anthropic shape:
 *  x-api-key + anthropic-version headers, {data:[{id}]}. Also accepts
 *  {models:[...]} and a plain string array, because providers vary. */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey?: string,
  api: ProviderApi = "openai",
): Promise<FetchModelsResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const headers: Record<string, string> = {};
    if (api === "anthropic") {
      if (apiKey) headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as unknown;
    let raw: unknown[] = [];
    if (Array.isArray(json)) raw = json;
    else if (json && typeof json === "object") {
      const obj = json as { data?: unknown; models?: unknown };
      if (Array.isArray(obj.data)) raw = obj.data;
      else if (Array.isArray(obj.models)) raw = obj.models;
    }
    const ids = raw
      .map((d) => (typeof d === "string" ? d : (d as { id?: unknown } | null)?.id))
      .filter((id): id is string => typeof id === "string");
    const out: string[] = [];
    for (const id of ids) {
      const trimmed = id.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
    return { ok: true, models: out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a provider's /v1/models endpoint. Never logs or returns the
 *  key; only counts and sample ids come back. */
export async function testProvider(
  provider: CustomProviderConfig,
  apiKey?: string,
): Promise<ProviderTestResult> {
  const fetched = await fetchProviderModels(provider.baseUrl, apiKey, normalizeApi(provider.api));
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const ids = fetched.models ?? [];
  return { ok: true, count: ids.length, sample: ids.slice(0, 10) };
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
