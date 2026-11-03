// Agent tool for swaps. EVM swaps prepare a human confirmation (never
// sign or broadcast); Solana swaps return a Jupiter quote only; Sui and
// Aptos are reported unsupported. The tool is signs:true and is stripped
// from the Telegram gateway — fund movement stays CLI/TUI-only, like all
// other signing flows.
import type { Tool } from "../agent.js";
import { prepareEvmSwap, prepareSolanaSwap } from "./index.js";

export function createSwapTool(deps: { fetchFn?: typeof fetch } = {}): Tool {
  return {
    name: "swap",
    description:
      "Prepare a token swap. EVM: chainId (56, 1, 137, 42161, 10, 8453, 43114), fromToken/toToken as 0x addresses or 'native', amount in human units, optional slippageBps (default 100 = 1%). Returns a HUMAN confirmation (the agent never signs; the human runs `pansa confirm <id>`), or a needsApproval step for ERC20 inputs. Solana: inputMint/outputMint base58 + inputDecimals, returns a Jupiter quote only (execution not supported yet). Sui/Aptos: unsupported. Read the quote (in/out/minOut) back to the human before any confirm.",
    parameters: {
      type: "object",
      properties: {
        wallet: { type: "string" },
        chain: { type: "string" },
        fromToken: { type: "string" },
        toToken: { type: "string" },
        amount: { type: "string" },
        inputDecimals: { type: "number" },
        slippageBps: { type: "number" },
      },
      required: ["wallet", "chain", "fromToken", "toToken", "amount"],
    },
    signs: true,
    execute: async (args: Record<string, unknown>) => {
      const wallet = String(args.wallet ?? "");
      const chain = String(args.chain ?? "");
      const fromToken = String(args.fromToken ?? "");
      const toToken = String(args.toToken ?? "");
      const amount = String(args.amount ?? "");
      const slippageBps = typeof args.slippageBps === "number" ? args.slippageBps : undefined;
      if (!wallet || !chain || !fromToken || !toToken || !amount) {
        return { ok: false, data: null, error: "Butuh wallet, chain, fromToken, toToken, amount." };
      }
      if (chain === "solana") {
        if (typeof args.inputDecimals !== "number") {
          return { ok: false, data: null, error: "Swap Solana butuh inputDecimals (desimal mint input)." };
        }
        const res = await prepareSolanaSwap({ inputMint: fromToken, outputMint: toToken, amount, inputDecimals: args.inputDecimals, slippageBps, fetchFn: deps.fetchFn });
        if (!res.ok || !res.data) return { ok: false, data: null, error: res.error };
        return { ok: true, data: res.data, signs: false };
      }
      if (chain === "sui" || chain === "aptos") {
        return { ok: false, data: null, error: `Swap ${chain} belum didukung (aggregator keyless belum terverifikasi; butuh integrasi SDK).` };
      }
      if (!/^\d+$/.test(chain)) {
        return { ok: false, data: null, error: `Chain tidak dikenal: ${chain}. Pakai chainId EVM (56, 1, …) atau solana/sui/aptos.` };
      }
      const res = await prepareEvmSwap({ wallet, chainId: chain, fromToken, toToken, amount, slippageBps, fetchFn: deps.fetchFn });
      if (!res.ok || !res.data) return { ok: false, data: null, error: res.error };
      return { ok: true, data: res.data, signs: true };
    },
  };
}
