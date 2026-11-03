import { loadViem } from "./viem-lazy.js";
import { resolveRpc } from "./rpc/index.js";

// EVM RPC access shared by balance lookup, testnet detection, simulation
// and broadcast. Resolution (see src/rpc/index.ts): explicit argument >
// PANSA_EVM_RPC > dashboard default for BSC (56) > legacy evmRpc in
// ~/.pansa/config.json. No endpoint means no EVM RPC feature (callers
// must fail closed, never fake data). Callers that need a different EVM
// chain resolve it via resolveRpc(chainId) directly.
export function resolveEvmRpc(explicit?: string): string | undefined {
  return resolveRpc("56", explicit);
}

export async function evmPublicClient(rpcUrl: string) {
  const { createPublicClient, http } = await loadViem();
  return createPublicClient({ transport: http(rpcUrl) });
}

export async function getEvmBalance(address: string, rpcUrl: string): Promise<bigint> {
  const client = await evmPublicClient(rpcUrl);
  return client.getBalance({ address: address as `0x${string}` });
}

export async function getEvmChainId(rpcUrl: string): Promise<number> {
  const client = await evmPublicClient(rpcUrl);
  return client.getChainId();
}

export async function formatEth(value: bigint): Promise<string> {
  const { formatEther } = await loadViem();
  return formatEther(value);
}

// Well-known EVM testnet chain IDs. Anything not on this list is treated
// as NOT a testnet (fail-closed): a mainnet or unknown chain never passes
// a testnet-only policy (B6).
export const TESTNET_CHAIN_IDS = new Set([
  11155111, // Sepolia
  17000, // Holesky
  80002, // Polygon Amoy
  97, // BNB Smart Chain Testnet
  43113, // Avalanche Fuji
  11155420, // OP Sepolia
  84532, // Base Sepolia
  421614, // Arbitrum Sepolia
  534351, // Scroll Sepolia
  300, // zkSync Sepolia
  59141, // Linea Sepolia
  168587773, // Blast Sepolia
  5003, // Mantle Sepolia
  80085, // Berachain bArtio
]);

export function isTestnetChainId(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId);
}
