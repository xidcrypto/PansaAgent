import { Tool } from "../agent.js";
import { TxRequest, parseTxValue } from "./transactions.js";
import { requestConfirmation, reject, formatConfirmationCard, listPendingConfirmations } from "./policy.js";
import { getPolicy } from "./policy.js";
import { getSpentToday } from "./ledger.js";
import { resolveEvmRpc, getEvmChainId, isTestnetChainId } from "../evm-rpc.js";
import { ChainFamily } from "./keystore.js";
import { walletRegistryLoad, defaultPath, validateName } from "./keystore.js";
import { getSignerClient } from "./client.js";
import { generateMnemonic } from "../mnemonic.js";
import { loadConfig, saveConfig } from "../config.js";
import { hasWalletPassword } from "../gateway/telegram.js";

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

// Wallet tools (natural-language path for the gateway's owner-only bot).
// Security properties, enforced here rather than in prompts:
// - Neither tool moves funds or signs anything (signs unset/false).
// - wallet_create returns ONLY name/family/address. The mnemonic is
//   generated, handed to the signer for encrypted storage, and never
//   placed in the result — so it can never reach the model's context,
//   a reply, or a log through this tool.
// - Arguments are validated server-side (chain allowlist, keystore name
//   rule); the model's words are never trusted.
// - The description tells the model to create ONLY on an explicit user
//   request with both chain and name, and to ask when either is
//   missing — so a vague prompt (or injected page text) cannot trigger
//   a creation on its own.
export function createWalletListTool(
  list?: () => Array<{ name: string; family: string; address: string }>,
): Tool {
  return {
    name: "wallet_list",
    description: "List wallets in the local keystore (names, chains, addresses). Addresses are public identifiers; this never returns mnemonics, private keys, or balances.",
    parameters: {},
    signs: false,
    async execute(): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const wallets = (list ?? walletRegistryLoad)();
      return { ok: true, data: { wallets }, signs: false };
    },
  };
}

export interface WalletCreateDeps {
  request?: (method: string, params: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  setDefault?: (chain: string, name: string) => void;
}

export function createWalletCreateTool(deps?: WalletCreateDeps): Tool {
  const request =
    deps?.request ??
    ((method: string, params: Record<string, unknown>) => getSignerClient().request(method, params));
  const setDefault =
    deps?.setDefault ??
    ((chain: string, name: string) => {
      const cfg = loadConfig();
      const defs = (cfg as any).defaultWallets ?? {};
      defs[chain] = name;
      (cfg as any).defaultWallets = defs;
      saveConfig(cfg);
    });
  return {
    name: "wallet_create",
    description:
      "Create a wallet in the local keystore. ONLY call this when the user explicitly asked to create a wallet AND gave both a chain and a name — if either is missing, ask the user instead of guessing. Returns only name, chain and address. It never returns, prints, or repeats the mnemonic or private key; those stay encrypted in the keystore. Creating a wallet never moves funds and never signs anything.",
    parameters: {
      chain: { type: "string", description: "Chain family: evm, solana, sui, or aptos" },
      name: { type: "string", description: "Wallet name: lowercase letters, digits, - and _, max 32 characters" },
    },
    signs: false,
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { chain, name } = args as { chain?: unknown; name?: unknown };
      if (typeof chain !== "string" || !["evm", "solana", "sui", "aptos"].includes(chain)) {
        return { ok: false, data: null, error: `Unsupported chain: ${String(chain)} (use evm, solana, sui, or aptos)` };
      }
      if (typeof name !== "string" || !name) {
        return { ok: false, data: null, error: "Missing wallet name" };
      }
      // First-creation rule, same as the deterministic path: no wallet
      // can be made before the shared wallet password exists. The model
      // must direct the user to /wallet set-password, never ask for the
      // password itself (it must never see one).
      try {
        if (!hasWalletPassword()) {
          return { ok: false, data: null, error: "WALLET_PASSWORD_REQUIRED: belum ada password dompet. Minta user mengatur dulu lewat /wallet set-password, lalu ulangi pembuatan." };
        }
      } catch {
        return { ok: false, data: null, error: "Tidak bisa memeriksa password dompet. Coba lagi." };
      }
      try {
        validateName(name);
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
      }
      const mnemonic = generateMnemonic(128);
      let res: { ok: boolean; result?: unknown; error?: string };
      try {
        res = await request("keystore.create", {
          name, family: chain, mnemonic, path: defaultPath(chain), passphrase: process.env.PANSA_PASSPHRASE ?? "",
        });
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
      }
      if (!res.ok) {
        return { ok: false, data: null, error: res.error ?? "keystore.create failed" };
      }
      const r = res.result as { name: string; family: string; address: string };
      try {
        setDefault(chain, name);
      } catch {
        // Creation succeeded; a default-pointer failure must not mask it
        // or trick the caller into retrying (which would hit "already
        // exists"). The wallet is usable by name regardless.
      }
      return { ok: true, data: { name: r.name, family: r.family, address: r.address }, signs: false };
    },
  };
}
