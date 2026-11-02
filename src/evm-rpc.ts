import { createPublicClient, http, formatEther } from "viem";
import { loadConfig } from "./config.js";

// EVM RPC access shared by balance lookup, testnet detection, simulation
// and broadcast. The endpoint is never hardcoded: explicit argument wins,
// then PANSA_EVM_RPC, then evmRpc in ~/.pansa/config.json. No endpoint
// means no EVM RPC feature (callers must fail closed, never fake data).
export function resolveEvmRpc(explicit?: string): string | undefined {
  return explicit ?? process.env.PANSA_EVM_RPC ?? loadConfig().evmRpc;
}

export function evmPublicClient(rpcUrl: string): ReturnType<typeof createPublicClient> {
  return createPublicClient({ transport: http(rpcUrl) });
}

export async function getEvmBalance(address: string, rpcUrl: string): Promise<bigint> {
  const client = evmPublicClient(rpcUrl);
  return client.getBalance({ address: address as `0x${string}` });
}

export async function getEvmChainId(rpcUrl: string): Promise<number> {
  const client = evmPublicClient(rpcUrl);
  return client.getChainId();
}

export function formatEth(value: bigint): string {
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
