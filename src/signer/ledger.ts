import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PANSA_DIR } from "../config.js";

// Persistent daily spend ledger (B9). Keyed by wallet|chain|UTC date so the
// per-day cap survives process restarts. Only successful broadcasts are
// recorded (see signer/execute.ts); pending confirmations do not count.
const LEDGER_FILE = `${PANSA_DIR}/spend-ledger.json`;

export type SpendLedger = Record<string, number>;

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function ledgerKey(wallet: string, chain: string, day: string): string {
  return `${wallet}|${chain}|${day}`;
}

export function loadLedger(): SpendLedger {
  try {
    if (!existsSync(LEDGER_FILE)) return {};
    return JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as SpendLedger;
  } catch {
    return {};
  }
}

export function saveLedger(ledger: SpendLedger): void {
  mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

export function getSpentToday(wallet: string, chain: string): number {
  return loadLedger()[ledgerKey(wallet, chain, dayKey())] ?? 0;
}

export function getSpentOn(wallet: string, chain: string, day: string): number {
  return loadLedger()[ledgerKey(wallet, chain, day)] ?? 0;
}

export function recordSpend(wallet: string, chain: string, amount: number): void {
  const ledger = loadLedger();
  const key = ledgerKey(wallet, chain, dayKey());
  ledger[key] = (ledger[key] ?? 0) + amount;
  saveLedger(ledger);
}
