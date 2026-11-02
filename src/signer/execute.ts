import { getConfirmation, markExecuted, reopenConfirmation } from "./policy.js";
import { getPolicy } from "./policy.js";
import { checkPolicy, parseTxValue, simulateTx } from "./transactions.js";
import { keystoreUnlock } from "./keystore.js";
import { getSpentToday, recordSpend } from "./ledger.js";
import { resolveEvmRpc, getEvmChainId, isTestnetChainId } from "../evm-rpc.js";
import { evmAccountFromMnemonic } from "./evm.js";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Execute a HUMAN-confirmed request: re-validate everything at broadcast
// time (expiry, policy, daily cap, live testnet check, fresh simulation),
// then sign + broadcast for real via viem. This function is only reachable
// from `pansa confirm` and CONFIRM in REPL/TUI — never from an LLM tool.
export async function executeConfirmed(
  id: string,
  passphrase: string,
): Promise<{ ok: boolean; hash?: string; error?: string }> {
  const req = getConfirmation(id);
  if (!req) return { ok: false, error: `Confirmation not found: ${id}` };
  if (req.status !== "confirmed") {
    return { ok: false, error: `Confirmation ${id} is ${req.status}, not confirmed` };
  }
  if (Date.now() > req.expiresAt) {
    return { ok: false, error: `Confirmation ${id} expired` };
  }
  const tx = req.tx;
  if (tx.chain !== "evm") {
    return { ok: false, error: `Execution not implemented for chain ${tx.chain} (EVM only)` };
  }

  const policy = getPolicy();
  // Re-resolve the live chain id and re-check policy + daily cap at
  // broadcast time; anything that changed since confirmation blocks.
  let isTestnet: boolean | undefined;
  let rpcUrl = tx.rpcUrl ?? resolveEvmRpc();
  if (!rpcUrl) {
    return { ok: false, error: "Cannot execute: no EVM RPC configured (set PANSA_EVM_RPC or evmRpc in config)" };
  }
  try {
    const chainId = await getEvmChainId(rpcUrl);
    tx.chainId = chainId;
    isTestnet = isTestnetChainId(chainId);
  } catch (err) {
    if (policy.testnetOnly) {
      return { ok: false, error: `Cannot verify testnet at execute time: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const spentToday = getSpentToday(tx.from, tx.chain);
  const policyCheck = checkPolicy(tx, policy, { spentToday, isTestnet });
  if (!policyCheck.ok) {
    return { ok: false, error: `Policy re-check failed: ${policyCheck.error}` };
  }
  if (tx.chainId === undefined) {
    return { ok: false, error: "Cannot execute: chain id could not be resolved from the RPC endpoint" };
  }
  // Fresh simulation at broadcast time; a stale stored simulation is not
  // trusted (the chain state may have changed since confirmation).
  const sim = await simulateTx(tx);
  if (!sim.ok) {
    return { ok: false, error: `Simulation re-check failed: ${sim.error}` };
  }

  // Unlock with the human-supplied passphrase (never stored, never logged).
  let mnemonic: string;
  let path: string;
  try {
    const unlocked = keystoreUnlock(tx.from, passphrase);
    mnemonic = unlocked.mnemonic;
    path = unlocked.path;
  } catch (err) {
    return { ok: false, error: `Unlock failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const { privateKey } = evmAccountFromMnemonic(mnemonic, path);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const chainId = tx.chainId!;
    const walletClient = createWalletClient({
      account,
      chain: {
        id: chainId,
        name: `chain-${chainId}`,
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      },
      transport: http(rpcUrl),
    });
    const parsed = parseTxValue(tx);
    const value = parsed.value ?? 0;
    const hash = await walletClient.sendTransaction({
      to: tx.to as `0x${string}`,
      value: tx.value ? parseEther(tx.value) : 0n,
      data: tx.data as `0x${string}` | undefined,
    });
    // Spend is recorded ONLY after a successful broadcast, using the real
    // broadcast hash (B9).
    recordSpend(tx.from, tx.chain, value);
    markExecuted(id, hash);
    return { ok: true, hash };
  } catch (err) {
    // Broadcast failed: reopen so the human can retry within the TTL.
    reopenConfirmation(id);
    return { ok: false, error: `Broadcast failed: ${err instanceof Error ? err.message : String(err)} (request reopened for retry)` };
  }
}
