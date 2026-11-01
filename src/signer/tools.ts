import { Tool } from "../agent.js";
import { TxRequest } from "./transactions.js";
import { requestConfirmation, confirm, reject, formatConfirmationCard, listPendingConfirmations } from "./policy.js";
import { getPolicy } from "./policy.js";

export function createSignTool(): Tool {
  return {
    name: "sign_transaction",
    description: "Sign and send a transaction (requires human confirmation)",
    parameters: {
      chain: { type: "string", description: "Chain family (evm, solana, sui, aptos)" },
      from_wallet: { type: "string", description: "Wallet name" },
      to: { type: "string", description: "Recipient address" },
      value: { type: "string", description: "Value in ETH/native token" },
      data: { type: "string", description: "Calldata (hex)" },
      gas_limit: { type: "string", description: "Gas limit" },
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { chain, from_wallet, to, value, data, gas_limit } = args as {
        chain: string; from_wallet: string; to: string; value?: string; data?: string; gas_limit?: string;
      };

      if (!["evm", "solana", "sui", "aptos"].includes(chain)) {
        return { ok: false, data: null, error: `Unsupported chain: ${chain}` };
      }
      if (!from_wallet || !to) {
        return { ok: false, data: null, error: "Missing from_wallet or to" };
      }

      const tx: TxRequest = {
        chain: chain as any,
        from: from_wallet,
        to,
        value,
        data,
        gasLimit: gas_limit,
      };

      const policy = getPolicy();
      const confirmationReq = await requestConfirmation(tx, policy);

      return {
        ok: true,
        data: {
          confirmation_id: confirmationReq.id,
          status: "pending_confirmation",
          card: formatConfirmationCard(confirmationReq),
          instruction: `Type CONFIRM ${confirmationReq.id} or REJECT ${confirmationReq.id}`,
        },
        signs: true,
      };
    },
  };
}

export function createConfirmTool(): Tool {
  return {
    name: "confirm_transaction",
    description: "Confirm a pending transaction by ID",
    parameters: {
      confirmation_id: { type: "string", description: "Confirmation ID from sign_transaction" },
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { confirmation_id } = args as { confirmation_id: string };

      const req = confirm(confirmation_id);
      if (!req) {
        return { ok: false, data: null, error: `Confirmation ${confirmation_id} not found or already processed` };
      }

      return {
        ok: true,
        data: {
          confirmation_id: req.id,
          status: "confirmed",
          tx: req.tx,
          next_step: "Transaction will be signed and broadcast",
        },
        signs: true,
      };
    },
  };
}

export function createRejectTool(): Tool {
  return {
    name: "reject_transaction",
    description: "Reject a pending transaction by ID",
    parameters: {
      confirmation_id: { type: "string", description: "Confirmation ID" },
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { confirmation_id } = args as { confirmation_id: string };

      const req = reject(confirmation_id);
      if (!req) {
        return { ok: false, data: null, error: `Confirmation ${confirmation_id} not found or already processed` };
      }

      return {
        ok: true,
        data: {
          confirmation_id: req.id,
          status: "rejected",
        },
        signs: false,
      };
    },
  };
}

export function createListConfirmationsTool(): Tool {
  return {
    name: "list_confirmations",
    description: "List all pending confirmations",
    parameters: {},
    async execute(): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const pending = listPendingConfirmations();
      return {
        ok: true,
        data: {
          count: pending.length,
          confirmations: pending.map(p => ({
            id: p.id,
            chain: p.tx.chain,
            to: p.tx.to,
            value: p.tx.value,
            status: p.status,
            expires_in_ms: p.expiresAt - Date.now(),
          })),
        },
        signs: false,
      };
    },
  };
}
