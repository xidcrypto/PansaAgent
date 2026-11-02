import { Tool } from "../agent.js";

interface BAWConfig {
  apiKey?: string;
  apiSecret?: string;
  baseUrl: string;
}

interface BAWWallet {
  id: string;
  name: string;
  address: string;
  chain: string;
  balance: string;
}

interface BAWTransferParams {
  fromWalletId: string;
  toAddress: string;
  amount: string;
  token: string;
  chain: string;
}

interface BAWSwapParams {
  walletId: string;
  fromToken: string;
  toToken: string;
  amount: string;
  chain: string;
  slippage?: number;
}

class BAWClient {
  private config: BAWConfig;

  constructor(config: BAWConfig = { baseUrl: "https://api.agenticwallet.binance.com/v1" }) {
    this.config = config;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["X-API-KEY"] = this.config.apiKey;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BAW API error: ${res.status} ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // Wallet methods
  async listWallets(): Promise<BAWWallet[]> {
    return this.request<BAWWallet[]>("GET", "/wallets");
  }

  async getWallet(walletId: string): Promise<BAWWallet> {
    return this.request<BAWWallet>("GET", `/wallets/${walletId}`);
  }

  // Transfer
  async transfer(params: BAWTransferParams): Promise<{ txId: string; status: string }> {
    return this.request("POST", "/transfers", params);
  }

  // Swap
  async swap(params: BAWSwapParams): Promise<{ txId: string; status: string; receivedAmount: string }> {
    return this.request("POST", "/swaps", params);
  }

  // Balance
  async getBalance(walletId: string, token: string): Promise<{ balance: string }> {
    return this.request("GET", `/wallets/${walletId}/balance?token=${token}`);
  }

  // Claims (airdrops)
  async listClaims(): Promise<Array<{ id: string; campaign: string; amount: string; status: string }>> {
    return this.request("GET", "/claims");
  }

  async claim(claimId: string): Promise<{ txId: string; status: string }> {
    return this.request("POST", `/claims/${claimId}/claim`);
  }
}

// Singleton instance
let bawClient: BAWClient | null = null;

export function getBAWClient(): BAWClient {
  if (!bawClient) {
    bawClient = new BAWClient();
  }
  return bawClient;
}

export function createBAWTool(): Tool {
  return {
    name: "baw",
    description: "Binance Agentic Wallet operations (wallets, transfers, swaps, claims)",
    parameters: {
      action: {
        type: "string",
        description: "Action: list_wallets, get_wallet, transfer, swap, balance, list_claims, claim",
      },
      wallet_id: { type: "string", description: "BAW wallet ID" },
      to_address: { type: "string", description: "Recipient address (for transfer)" },
      amount: { type: "string", description: "Amount" },
      token: { type: "string", description: "Token symbol" },
      chain: { type: "string", description: "Chain (bsc, eth, arb, op, base, polygon)" },
      from_token: { type: "string", description: "From token (for swap)" },
      to_token: { type: "string", description: "To token (for swap)" },
      slippage: { type: "number", description: "Slippage tolerance (for swap)" },
      claim_id: { type: "string", description: "Claim ID (for claim)" },
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { action, wallet_id, to_address, amount, token, chain, from_token, to_token, slippage, claim_id } = args as {
        action: string;
        wallet_id?: string;
        to_address?: string;
        amount?: string;
        token?: string;
        chain?: string;
        from_token?: string;
        to_token?: string;
        slippage?: number;
        claim_id?: string;
      };

      const client = getBAWClient();

      try {
        switch (action) {
          case "list_wallets": {
            const wallets = await client.listWallets();
            return { ok: true, data: { wallets }, signs: false };
          }

          case "get_wallet": {
            if (!wallet_id) return { ok: false, data: null, error: "wallet_id required", signs: false };
            const wallet = await client.getWallet(wallet_id);
            return { ok: true, data: wallet, signs: false };
          }

          case "balance": {
            if (!wallet_id || !token) return { ok: false, data: null, error: "wallet_id and token required", signs: false };
            const balance = await client.getBalance(wallet_id, token);
            return { ok: true, data: balance, signs: false };
          }

          case "transfer": {
            if (!wallet_id || !to_address || !amount || !token || !chain) {
              return { ok: false, data: null, error: "wallet_id, to_address, amount, token, chain required", signs: true };
            }
            const result = await client.transfer({ fromWalletId: wallet_id, toAddress: to_address, amount, token, chain });
            return { ok: true, data: result, signs: true };
          }

          case "swap": {
            if (!wallet_id || !from_token || !to_token || !amount || !chain) {
              return { ok: false, data: null, error: "wallet_id, from_token, to_token, amount, chain required", signs: true };
            }
            const result = await client.swap({ walletId: wallet_id, fromToken: from_token, toToken: to_token, amount, chain, slippage });
            return { ok: true, data: result, signs: true };
          }

          case "list_claims": {
            const claims = await client.listClaims();
            return { ok: true, data: { claims }, signs: false };
          }

          case "claim": {
            if (!claim_id) return { ok: false, data: null, error: "claim_id required", signs: true };
            const result = await client.claim(claim_id);
            return { ok: true, data: result, signs: true };
          }

          default:
            return { ok: false, data: null, error: `Unknown BAW action: ${action}`, signs: false };
        }
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), signs: false };
      }
    },
  };
}