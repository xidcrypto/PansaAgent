// Batch: run one read-only job across several registry wallets, one at a
// time, in the order given. Sequential on purpose: it keeps RPC and price
// lookups deterministic and avoids burst rate-limits. A wallet that fails
// is reported as a failed entry — it never aborts the rest of the batch
// and never hides behind the other wallets' successes.
//
// Batch only fans out read-only jobs (balance, portfolio). It never
// signs, approves, or broadcasts: a batch that could move funds in one
// command would bypass the per-transaction human confirmation the whole
// signer is built around.

import type { WalletRecord } from "../signer/keystore.js";

export interface BatchEntry<T> {
  wallet: WalletRecord;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface BatchSelection {
  selected: WalletRecord[];
  unknown: string[];
}

/** Empty request means "all registry wallets"; otherwise only the named
 *  ones, in request order. Unknown names are reported, not thrown. */
export function selectBatchWallets(requested: string[], registry: WalletRecord[]): BatchSelection {
  if (!requested.length) return { selected: [...registry], unknown: [] };
  const selected: WalletRecord[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const found = registry.find((w) => w.name === name);
    if (found) selected.push(found);
    else unknown.push(name);
  }
  return { selected, unknown };
}

export async function runBatch<T>(
  wallets: WalletRecord[],
  fn: (wallet: WalletRecord) => Promise<T>,
): Promise<Array<BatchEntry<T>>> {
  const out: Array<BatchEntry<T>> = [];
  for (const wallet of wallets) {
    try {
      out.push({ wallet, ok: true, result: await fn(wallet) });
    } catch (err) {
      out.push({ wallet, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export function formatBatchSummary<T>(entries: Array<BatchEntry<T>>, unknown: string[]): string {
  const ok = entries.filter((e) => e.ok).length;
  const fail = entries.length - ok;
  const parts = [`Batch selesai: ${ok} berhasil, ${fail} gagal`];
  if (unknown.length) parts.push(`Dompet tidak ditemukan: ${unknown.join(", ")}`);
  return parts.join(" · ");
}
