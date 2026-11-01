import { PolicyConfig, TxRequest, checkPolicy, simulateTx, generateConfirmationId } from "./transactions.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { PANSA_DIR } from "../config.js";

export interface ConfirmationRequest {
  id: string;
  tx: TxRequest;
  simulation: { ok: boolean; gasUsed?: string; success?: boolean; error?: string };
  policyCheck: { ok: boolean; error?: string };
  createdAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "rejected" | "expired";
}

const PENDING_CONFIRMATIONS = new Map<string, ConfirmationRequest>();
const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function savePolicy(policy: PolicyConfig): void {
  const policyFile = `${PANSA_DIR}/policy.json`;
  mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(policyFile, JSON.stringify(policy, null, 2), { mode: 0o600 });
}

export function getPolicy(): PolicyConfig {
  const policyFile = `${PANSA_DIR}/policy.json`;
  if (!existsSync(policyFile)) {
    return {
      spendCapPerTx: 0.01,
      spendCapPerDay: 0.05,
      allowedChains: ["evm", "solana", "sui", "aptos"],
      requireConfirmation: true,
      testnetOnly: true,
    };
  }
  try {
    const data = JSON.parse(readFileSync(policyFile, "utf8"));
    return data as PolicyConfig;
  } catch {
    return {
      spendCapPerTx: 0.01,
      spendCapPerDay: 0.05,
      allowedChains: ["evm", "solana", "sui", "aptos"],
      requireConfirmation: true,
      testnetOnly: true,
    };
  }
}

export async function requestConfirmation(tx: TxRequest, policy: PolicyConfig): Promise<ConfirmationRequest> {
  const id = generateConfirmationId();
  const [simulation, policyCheck] = await Promise.all([
    simulateTx(tx),
    Promise.resolve(checkPolicy(tx, policy)),
  ]);

  const now = Date.now();
  const req: ConfirmationRequest = {
    id,
    tx,
    simulation,
    policyCheck,
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    status: "pending",
  };

  PENDING_CONFIRMATIONS.set(id, req);
  return req;
}

export function confirm(id: string): ConfirmationRequest | null {
  const req = PENDING_CONFIRMATIONS.get(id);
  if (!req) return null;
  if (req.status !== "pending") return null;
  if (Date.now() > req.expiresAt) {
    req.status = "expired";
    PENDING_CONFIRMATIONS.set(id, req);
    return null;
  }
  if (!req.policyCheck.ok) {
    req.status = "rejected";
    PENDING_CONFIRMATIONS.set(id, req);
    return null;
  }
  req.status = "confirmed";
  PENDING_CONFIRMATIONS.set(id, req);
  return req;
}

export function reject(id: string): ConfirmationRequest | null {
  const req = PENDING_CONFIRMATIONS.get(id);
  if (!req) return null;
  if (req.status !== "pending") return null;
  req.status = "rejected";
  PENDING_CONFIRMATIONS.set(id, req);
  return req;
}

export function getConfirmation(id: string): ConfirmationRequest | undefined {
  return PENDING_CONFIRMATIONS.get(id);
}

export function listPendingConfirmations(): ConfirmationRequest[] {
  const now = Date.now();
  const result: ConfirmationRequest[] = [];
  for (const req of PENDING_CONFIRMATIONS.values()) {
    if (req.status === "pending" && now <= req.expiresAt) {
      result.push(req);
    } else if (now > req.expiresAt && req.status === "pending") {
      req.status = "expired";
      PENDING_CONFIRMATIONS.set(req.id, req);
    }
  }
  return result;
}

export function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, req] of PENDING_CONFIRMATIONS.entries()) {
    if (now > req.expiresAt && req.status === "pending") {
      req.status = "expired";
      PENDING_CONFIRMATIONS.set(id, req);
    }
  }
}

export function formatConfirmationCard(req: ConfirmationRequest): string {
  const statusIcon = req.status === "pending" ? "⏳" : req.status === "confirmed" ? "✅" : req.status === "rejected" ? "❌" : "⏰";
  const timeLeft = Math.max(0, Math.floor((req.expiresAt - Date.now()) / 1000));
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;

  return `
╭─ CONFIRMATION REQUIRED ${statusIcon} ─────────────────────────────────────╮
│ ID: ${req.id.padEnd(56)}│
├─────────────────────────────────────────────────────────────────────────────┤
│ Chain: ${req.tx.chain.toUpperCase().padEnd(55)}│
│ From: ${req.tx.from.slice(0, 10)}...${req.tx.from.slice(-8)}.padEnd(44)}│
│ To: ${req.tx.to.slice(0, 10)}...${req.tx.to.slice(-8)}.padEnd(45)}│
│ Value: ${(req.tx.value ?? "0").padEnd(55)}│
│ Gas Limit: ${(req.tx.gasLimit ?? "auto").padEnd(51)}│
├─────────────────────────────────────────────────────────────────────────────┤
│ Simulation: ${req.simulation.ok ? "✓ Success" : "✗ Failed"} ${req.simulation.gasUsed ? `(gas: ${req.simulation.gasUsed})` : ""}
│ Policy Check: ${req.policyCheck.ok ? "✓ Passed" : `✗ ${req.policyCheck.error}`}
├─────────────────────────────────────────────────────────────────────────────┤
│ Expires in: ${minutes}m ${seconds}s
│ Confirm: CONFIRM ${req.id}
│ Reject:  REJECT ${req.id}
╰─────────────────────────────────────────────────────────────────────────────╯
`.trim();
}
