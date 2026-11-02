import { Tool } from "../agent.js";
import { TxRequest, parseTxValue } from "./transactions.js";
import { requestConfirmation, reject, formatConfirmationCard, listPendingConfirmations } from "./policy.js";
import { getPolicy } from "./policy.js";
import { getSpentToday } from "./ledger.js";
import { resolveEvmRpc, getEvmChainId, isTestnetChainId } from "../evm-rpc.js";
import { ChainFamily } from "./keystore.js";

export function createSignTool(): Tool {
  return {
    name: "sign_transaction",
    description: "Create a transaction for HUMAN confirmation (does not sign or broadcast). The human confirms with `pansa confirm <id>` or by typing CONFIRM <id> in the REPL/TUI.",
    parameters: {
      chain: { type: "string", description: "Chain family (evm, solana, sui, aptos)" },
      from_wallet: { type: "string", description: "Wallet name" },
      to: { type: "string", description: "Recipient address" },
      value: { type: "string", description: "Value in ETH/native token" },
      data: { type: "string", description: "Calldata (hex)" },
      gas_limit: { type: "string", description: "Gas limit" },
    },
    signs: true,
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
        chain: chain as ChainFamily,
        from: from_wallet,
        to,
        value,
        data,
        gasLimit: gas_limit,
      };

      // Reject non-numeric/negative values before any policy or simulation
      // work (B9). NaN would otherwise sail past every cap comparison.
      const parsed = parseTxValue(tx);
      if (!parsed.ok) {
        return { ok: false, data: null, error: parsed.error };
      }

      const policy = getPolicy();

      // Real testnet detection (B6, fail-closed): resolve the live chain id
      // from the RPC endpoint. Under a testnet-only policy, an unknown or
      // unreachable network refuses instead of assuming testnet.
      let isTestnet: boolean | undefined;
      if (chain === "evm") {
        const rpcUrl = resolveEvmRpc();
        if (rpcUrl) {
          try {
            const chainId = await getEvmChainId(rpcUrl);
            tx.chainId = chainId;
            tx.rpcUrl = rpcUrl;
            isTestnet = isTestnetChainId(chainId);
          } catch (err) {
            if (policy.testnetOnly) {
              return { ok: false, data: null, error: `Cannot verify testnet: ${err instanceof Error ? err.message : String(err)}` };
            }
            // testnet check disabled: proceed without a resolved chain id.
            // Signing/broadcast still requires a chain id and will fail
            // honestly at execute time.
          }
        } else if (policy.testnetOnly) {
          return { ok: false, data: null, error: "Cannot verify testnet: no EVM RPC configured (set PANSA_EVM_RPC or evmRpc in config)" };
        }
      } else if (policy.testnetOnly) {
        // No RPC-based testnet detection for non-EVM chains yet: fail closed.
        return { ok: false, data: null, error: `Cannot verify testnet for ${chain}: testnet detection is EVM-only` };
      }

      const spentToday = getSpentToday(from_wallet, tx.chain);
      const confirmationReq = await requestConfirmation(tx, policy, { spentToday, isTestnet });
      if (!confirmationReq.policyCheck.ok) {
        return { ok: false, data: null, error: confirmationReq.policyCheck.error };
      }

      return {
        ok: true,
        data: {
          confirmation_id: confirmationReq.id,
          status: "pending_confirmation",
          card: formatConfirmationCard(confirmationReq),
          instruction: `HUMAN confirmation required: run \`pansa confirm ${confirmationReq.id}\` or type CONFIRM ${confirmationReq.id} in the REPL/TUI. The agent must never confirm.`,
        },
        signs: true,
      };
    },
  };
}

// NOTE (B8): there is deliberately NO confirm_transaction tool. An LLM must
// never be able to confirm a transaction by calling a tool; confirmation
// comes only from a human via `pansa confirm <id>` or CONFIRM in REPL/TUI.

export function createRejectTool(): Tool {
  return {
    name: "reject_transaction",
    description: "Reject a pending transaction by ID",
    parameters: {
      confirmation_id: { type: "string", description: "Confirmation ID" },
    },
    signs: false,
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { confirmation_id } = args as { confirmation_id: string };

      const result = reject(confirmation_id);
      if (!result.ok) {
        return { ok: false, data: null, error: result.error };
      }

      return {
        ok: true,
        data: {
          confirmation_id: result.req!.id,
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
    signs: false,
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
