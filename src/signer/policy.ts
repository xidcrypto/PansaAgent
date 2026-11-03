import { PANSA_DIR } from "../config.js";
import { TxRequest, TxSimulation, PolicyConfig, checkPolicy, loadPolicy, validatePolicy, PolicyCheckOptions, simulateTx, generateConfirmationId } from "./transactions.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Pending confirmations are persisted to disk (mode 600) so a human can
// confirm from a different process (`pansa confirm <id>`) than the one that
// created the request. A confirmation is NEVER granted by an LLM tool.
const PENDING_FILE = `${PANSA_DIR}/confirmations.json`;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface ConfirmationRequest {
  id: string;
  tx: TxRequest;
  simulation: TxSimulation;
  policyCheck: { ok: boolean; error?: string };
  createdAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "rejected" | "executed" | "expired";
  txHash?: string;
}

function readPending(): Map<string, ConfirmationRequest> {
  try {
    if (!existsSync(PENDING_FILE)) return new Map();
    const arr = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as ConfirmationRequest[];
    return new Map(arr.map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

function writePending(map: Map<string, ConfirmationRequest>): void {
  mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PENDING_FILE, JSON.stringify([...map.values()], null, 2), { mode: 0o600 });
}

export function getPolicy(): PolicyConfig {
  return loadPolicy();
}

export function savePolicy(policy: PolicyConfig): void {
  const validated = validatePolicy(policy);
  mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(`${PANSA_DIR}/policy.json`, JSON.stringify(validated, null, 2), { mode: 0o600 });
}

export async function requestConfirmation(
  tx: TxRequest,
  policy: PolicyConfig,
  opts: PolicyCheckOptions = {},
): Promise<ConfirmationRequest> {
  const policyCheck = checkPolicy(tx, policy, opts);
  const simulation = await simulateTx(tx);
  const now = Date.now();
  const req: ConfirmationRequest = {
    id: generateConfirmationId(),
    tx,
    simulation,
    policyCheck,
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    // Policy-rejected requests are reported but never stored as pending.
    status: policyCheck.ok ? "pending" : "rejected",
  };
  if (policyCheck.ok) {
    const pending = readPending();
    pending.set(req.id, req);
    writePending(pending);
  }
  return req;
}

export function getConfirmation(id: string): ConfirmationRequest | undefined {
  return readPending().get(id);
}

export function listPendingConfirmations(): ConfirmationRequest[] {
  const pending = readPending();
  const now = Date.now();
  let changed = false;
  for (const req of pending.values()) {
    if (req.status === "pending" && now > req.expiresAt) {
      req.status = "expired";
      pending.set(req.id, req);
      changed = true;
    }
  }
  if (changed) writePending(pending);
  return [...pending.values()].filter((r) => r.status === "pending");
}

// Human confirmation (M7): blocked when the policy check fails, when the
// request expired, and when simulation failed or is unavailable. Returns a
// result object so callers can report the exact reason instead of a bare
// null.
export function confirm(id: string): { ok: boolean; req?: ConfirmationRequest; error?: string } {
  const pending = readPending();
  const req = pending.get(id);
  if (!req) return { ok: false, error: `Confirmation not found: ${id}` };
  if (req.status !== "pending") return { ok: false, error: `Confirmation ${id} is already ${req.status}` };
  if (Date.now() > req.expiresAt) {
    req.status = "expired";
    pending.set(id, req);
    writePending(pending);
    return { ok: false, error: `Confirmation ${id} expired` };
  }
  if (!req.policyCheck.ok) {
    req.status = "rejected";
    pending.set(id, req);
    writePending(pending);
    return { ok: false, error: req.policyCheck.error ?? "Policy check failed" };
  }
  if (!req.simulation.ok) {
    req.status = "rejected";
    pending.set(id, req);
    writePending(pending);
    return { ok: false, error: `Simulation failed: ${req.simulation.error ?? "unknown"}` };
  }
  req.status = "confirmed";
  pending.set(id, req);
  writePending(pending);
  return { ok: true, req };
}

export function reject(id: string): { ok: boolean; req?: ConfirmationRequest; error?: string } {
  const pending = readPending();
  const req = pending.get(id);
  if (!req) return { ok: false, error: `Confirmation not found: ${id}` };
  if (req.status !== "pending") return { ok: false, error: `Confirmation ${id} is already ${req.status}` };
  req.status = "rejected";
  pending.set(id, req);
  writePending(pending);
  return { ok: true, req };
}

// Mark a confirmed request as executed (after broadcast) and record its hash.
export function markExecuted(id: string, txHash: string): ConfirmationRequest | undefined {
  const pending = readPending();
  const req = pending.get(id);
  if (!req) return undefined;
  req.status = "executed";
  req.txHash = txHash;
  pending.set(id, req);
  writePending(pending);
  return req;
}

// Reopen a confirmed request back to pending (e.g. after a failed
// broadcast) so the human can retry within the original TTL.
export function reopenConfirmation(id: string): ConfirmationRequest | undefined {
  const pending = readPending();
  const req = pending.get(id);
  if (!req || req.status !== "confirmed") return undefined;
  if (Date.now() > req.expiresAt) {
    req.status = "expired";
    pending.set(id, req);
    writePending(pending);
    return undefined;
  }
  req.status = "pending";
  pending.set(id, req);
  writePending(pending);
  return req;
}

export function cleanupExpired(): void {
  const pending = readPending();
  const now = Date.now();
  let changed = false;
  for (const req of pending.values()) {
    if (now > req.expiresAt && req.status === "pending") {
      req.status = "expired";
      pending.set(req.id, req);
      changed = true;
    }
  }
  if (changed) writePending(pending);
}

export function formatConfirmationCard(req: ConfirmationRequest): string {
  const statusIcon = req.status === "pending" ? "⏳" : req.status === "confirmed" ? "✅" : req.status === "rejected" ? "❌" : req.status === "executed" ? "✅" : "⏰";
  const timeLeft = Math.max(0, Math.floor((req.expiresAt - Date.now()) / 1000));
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const truncate = (addr: string) => `${addr.slice(0, 10)}...${addr.slice(-8)}`;

  return `
╭─ CONFIRMATION REQUIRED ${statusIcon} ─────────────────────────────────────╮
│ ID: ${req.id.padEnd(56)}│
├─────────────────────────────────────────────────────────────────────────────┤
│ Chain: ${req.tx.chain.toUpperCase().padEnd(55)}│
│ From: ${truncate(req.tx.from).padEnd(44)}│
│ To: ${truncate(req.tx.to).padEnd(46)}│
│ Value: ${(req.tx.value ?? "0").padEnd(55)}│
│ Gas Limit: ${(req.tx.gasLimit ?? "auto").padEnd(51)}│
${req.tx.note ? `│ Catatan: ${req.tx.note.slice(0, 55).padEnd(51)}│\n` : ""}├─────────────────────────────────────────────────────────────────────────────┤
│ Simulation: ${req.simulation.ok ? "✓ Success" : "✗ Failed"} ${req.simulation.gasUsed ? `(gas: ${req.simulation.gasUsed})` : req.simulation.error ? `(${req.simulation.error})` : ""}
│ Policy Check: ${req.policyCheck.ok ? "✓ Passed" : `✗ ${req.policyCheck.error}`}
├─────────────────────────────────────────────────────────────────────────────┤
│ Expires in: ${minutes}m ${seconds}s
│ Confirm: CONFIRM ${req.id}
│ Reject:  REJECT ${req.id}
╰─────────────────────────────────────────────────────────────────────────────╯
`.trim();
}
