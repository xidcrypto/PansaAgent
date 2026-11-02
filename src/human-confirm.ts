import { confirm, reject, getConfirmation } from "./signer/policy.js";
import { executeConfirmed } from "./signer/execute.js";

// Human-only confirmation flow (B8). Shared by `pansa confirm`, the REPL
// and the TUI. An LLM tool must never call this: it runs only from a
// human-typed command. The passphrase is checked BEFORE confirm() so a
// missing passphrase leaves the request pending (retryable).
export async function humanConfirm(id: string): Promise<number> {
  const existing = getConfirmation(id);
  if (!existing) {
    process.stderr.write(`Confirmation not found: ${id}\n`);
    return 1;
  }
  if (existing.status !== "pending") {
    process.stderr.write(`Confirmation ${id} is already ${existing.status}\n`);
    return 1;
  }
  const passphrase = process.env.PANSA_PASSPHRASE;
  if (!passphrase) {
    process.stderr.write("PANSA_PASSPHRASE diperlukan untuk menandatangani dan broadcast.\n");
    return 1;
  }
  const result = confirm(id);
  if (!result.ok) {
    process.stderr.write(`Konfirmasi gagal: ${result.error}\n`);
    return 1;
  }
  const exec = await executeConfirmed(id, passphrase);
  if (!exec.ok) {
    process.stderr.write(`Eksekusi gagal: ${exec.error}\n`);
    return 1;
  }
  process.stdout.write(`Transaksi dieksekusi. Hash: ${exec.hash}\n`);
  return 0;
}

export function humanReject(id: string): number {
  const result = reject(id);
  if (!result.ok) {
    process.stderr.write(`Reject gagal: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`Konfirmasi ${id} ditolak.\n`);
  return 0;
}
