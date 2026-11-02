import { mnemonicToAccount } from "viem/accounts";

export type EvmAccount = { address: string; privateKey: string; path: string };

export const DEFAULT_EVM_PATH = "m/44'/60'/0'/0/0";

export function evmAccountFromMnemonic(mnemonic: string, path: string = DEFAULT_EVM_PATH): EvmAccount {
  const acc = (mnemonicToAccount as any)(mnemonic, { path });
  // This viem version's HD account does not expose `privateKey` directly;
  // the key lives on the HD node returned by getHdKey().
  const hd = typeof acc.getHdKey === "function" ? acc.getHdKey() : undefined;
  const raw = hd?.privateKey as Uint8Array | null | undefined;
  if (!raw) throw new Error("failed to derive EVM private key from mnemonic");
  return {
    address: acc.address,
    privateKey: ("0x" + Buffer.from(raw).toString("hex")) as string,
    path,
  };
}

export function isEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
