import { createInterface } from "node:readline";
import { keystoreCreate, keystoreList, keystoreUnlock, walletRegistryAdd, WalletRecord, ChainFamily } from "./keystore.js";
import { evmAccountFromMnemonic } from "./evm.js";
import { solanaAccountFromMnemonic } from "./solana.js";
import { suiAccountFromMnemonic } from "./sui.js";
import { aptosAccountFromMnemonic } from "./aptos.js";

// Unlocked wallets held in memory only (process lifetime). Map name -> decrypted payload.
const UNLOCKED = new Map<string, { family: ChainFamily; mnemonic: string; path: string }>();

function accountFor(family: ChainFamily, mnemonic: string, path: string): { address: string; privateKey: string | Buffer } {
  switch (family) {
    case "evm":
      return evmAccountFromMnemonic(mnemonic, path);
    case "solana": {
      const a = solanaAccountFromMnemonic(mnemonic, path);
      return { address: a.address, privateKey: a.privateKey };
    }
    case "sui": {
      const a = suiAccountFromMnemonic(mnemonic, path);
      return { address: a.address, privateKey: a.privateKey };
    }
    case "aptos": {
      const a = aptosAccountFromMnemonic(mnemonic, path);
      return { address: a.address, privateKey: a.privateKey };
    }
  }
}

export interface RpcRequest { id: unknown; method: string; params?: Record<string, unknown> }
export interface RpcResponse { id: unknown; ok: boolean; result?: unknown; error?: string }

function handle(req: RpcRequest): RpcResponse {
  try {
    switch (req.method) {
      case "keystore.create": {
        const { name, family, mnemonic, path, passphrase } = (req.params ?? {}) as {
          name: string; family: ChainFamily; mnemonic: string; path: string; passphrase: string;
        };
        keystoreCreate(name, family, mnemonic, path, passphrase);
        const acc = accountFor(family, mnemonic, path);
        const record: WalletRecord = { name, family, address: acc.address, path, createdAt: new Date().toISOString() };
        walletRegistryAdd(record);
        return { id: req.id, ok: true, result: { name, family, address: acc.address, path } };
      }
      case "keystore.list": {
        return { id: req.id, ok: true, result: { names: keystoreList() } };
      }
      case "wallet.unlock": {
        const { name, passphrase } = (req.params ?? {}) as { name: string; passphrase: string };
        const payload = keystoreUnlock(name, passphrase);
        UNLOCKED.set(name, payload);
        const acc = accountFor(payload.family, payload.mnemonic, payload.path);
        return { id: req.id, ok: true, result: { name, family: payload.family, address: acc.address } };
      }
      case "wallet.address": {
        const { name } = (req.params ?? {}) as { name: string };
        const unlocked = UNLOCKED.get(name);
        if (unlocked) {
          const acc = accountFor(unlocked.family, unlocked.mnemonic, unlocked.path);
          return { id: req.id, ok: true, result: { name, family: unlocked.family, address: acc.address } };
        }
        // fall back to registry (public)
        // registry not imported here to keep server small; address requires unlock
        return { id: req.id, ok: false, error: `wallet not unlocked: ${name}` };
      }
      default:
        return { id: req.id, ok: false, error: `unknown method: ${req.method}` };
    }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function runStdio(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ id: undefined, ok: false, error: "invalid JSON" }) + "\n");
      return;
    }
    const res = handle(req);
    process.stdout.write(JSON.stringify(res) + "\n");
  });
  rl.on("close", () => process.exit(0));
}

if (process.env.PANSA_SIGNER_SERVER === "1") {
  runStdio();
}
