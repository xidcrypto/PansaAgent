import { existsSync } from "node:fs";
import { PANSA_DIR, CONFIG_FILE, POLICY_FILE, KEYSTORE_DIR, DB_FILE } from "./config.js";
import { loadConfig } from "./config.js";
import { loadPolicy } from "./signer/transactions.js";
import { walletRegistryLoad } from "./signer/keystore.js";
import { fetchLiveModels } from "./llm.js";

// Shared health checks used by `pansa doctor` and the TUI /doctor
// command. The daemon check is read-only: it never spawns a daemon.
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "node", ok: true, detail: process.version });
  checks.push({ name: "PANSA_DIR", ok: existsSync(PANSA_DIR), detail: PANSA_DIR });
  try {
    loadConfig();
    checks.push({ name: "config", ok: true, detail: CONFIG_FILE });
  } catch (err) {
    checks.push({ name: "config", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  const policy = loadPolicy();
  checks.push({
    name: "policy",
    ok: true,
    detail: `per-tx ${policy.spendCapPerTx}, per-day ${policy.spendCapPerDay}, testnetOnly ${policy.testnetOnly}`,
  });
  checks.push({ name: "policy file", ok: existsSync(POLICY_FILE), detail: POLICY_FILE });
  checks.push({ name: "keystore dir", ok: existsSync(KEYSTORE_DIR), detail: KEYSTORE_DIR });
  checks.push({ name: "database", ok: true, detail: `${DB_FILE} (dibuka saat pertama dipakai)` });
  let wallets = 0;
  try {
    wallets = walletRegistryLoad().length;
    checks.push({ name: "wallets", ok: true, detail: `${wallets} terdaftar` });
  } catch (err) {
    checks.push({ name: "wallets", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  try {
    const live = await fetchLiveModels();
    checks.push({ name: "LLM daemon", ok: true, detail: `${live.length} model live` });
  } catch (err) {
    checks.push({ name: "LLM daemon", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  try {
    const { listScheduled } = await import("./scheduler/index.js");
    const tasks = listScheduled();
    checks.push({ name: "scheduler", ok: true, detail: `${tasks.length} tugas terjadwal (tabel bisa dibaca)` });
  } catch (err) {
    checks.push({ name: "scheduler", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  try {
    const { listAlerts } = await import("./alerts/index.js");
    const active = listAlerts("active");
    checks.push({ name: "alerts", ok: true, detail: `${active.length} alert aktif (tabel bisa dibaca)` });
  } catch (err) {
    checks.push({ name: "alerts", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  try {
    const cfg = loadConfig();
    const gw = cfg.gateways?.telegram;
    checks.push({
      name: "gateway",
      ok: true,
      detail: gw ? `telegram dikonfigurasi (${gw.allowlist.length} chat di allowlist)` : "telegram belum dikonfigurasi",
    });
    const servers = cfg.mcpServers ?? {};
    checks.push({ name: "mcp", ok: true, detail: `${Object.keys(servers).length} server dikonfigurasi` });
  } catch (err) {
    checks.push({ name: "gateway/mcp", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    req.resolve("playwright");
    checks.push({ name: "playwright", ok: true, detail: "terinstal (browser aktif bila config.browser=true)" });
  } catch {
    checks.push({ name: "playwright", ok: false, detail: "tidak terinstal (peer opsional; jalankan: npm i playwright)" });
  }
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");
}
