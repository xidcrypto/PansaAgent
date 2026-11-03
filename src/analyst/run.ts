// Shared analyst runner: one routing for the CLI skill surface and the
// agent tool. Routes by address format, never by guess. EVM targets need
// a configured EVM RPC (fail closed); Solana mints use resolveSolanaRpc
// (public default, overridable). Read-only: no signing, no transactions.
import { analyzeContract, type AnalystRpc } from "./index.js";
import { analyzeSolanaMint, createSolanaRpc, isSolanaAddress, resolveSolanaRpc } from "./solana.js";
import { resolveScoutTarget } from "../scout/index.js";
import { evmPublicClient, resolveEvmRpc } from "../evm-rpc.js";

export interface AnalystRunOpts {
  wallet?: string;
  fetchFn?: typeof fetch;
  solanaRpcUrl?: string;
  evmRpcUrl?: string;
}

export async function runAnalyst(
  target: string,
  opts: AnalystRunOpts = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!target) return { ok: false, error: "Butuh address kontrak (atau URL proyek)." };
  if (isSolanaAddress(target)) {
    const rpc = createSolanaRpc(resolveSolanaRpc(opts.solanaRpcUrl), opts.fetchFn);
    const report = await analyzeSolanaMint(target, rpc, { fetchFn: opts.fetchFn });
    return { ok: true, data: report };
  }
  const resolved = await resolveScoutTarget(target).catch(() => null);
  if (!resolved) {
    return { ok: false, error: "Target tidak dapat diurai: butuh alamat kontrak 0x…, mint Solana (base58), atau URL proyek." };
  }
  const rpcUrl = resolveEvmRpc(opts.evmRpcUrl);
  if (!rpcUrl) return { ok: false, error: "RPC EVM tidak terkonfigurasi (set PANSA_EVM_RPC atau config)." };
  const client = await evmPublicClient(rpcUrl);
  const rpc: AnalystRpc = {
    getCode: (address: string) => client.getCode({ address: address as `0x${string}` }),
    call: async (to: string, data: string) => {
      const res = await client.call({ to: to as `0x${string}`, data: data as `0x${string}` });
      return res.data ?? "0x";
    },
    getStorageAt: async (address: string, slot: string) =>
      (await client.getStorageAt({ address: address as `0x${string}`, slot: slot as `0x${string}` })) ?? "0x",
  };
  const chainId = await client.getChainId().catch(() => undefined);
  const report = await analyzeContract(resolved.address, rpc, { wallet: opts.wallet, chainId });
  return { ok: true, data: report };
}
