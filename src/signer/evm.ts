import { mnemonicToAccount } from "viem/accounts";

export type EvmAccount = { address: string; privateKey: string; path: string };

export const DEFAULT_EVM_PATH = "m/44'/60'/0'/0/0";

export function evmAccountFromMnemonic(mnemonic: string, path: string = DEFAULT_EVM_PATH): EvmAccount {
  const acc = (mnemonicToAccount as any)(mnemonic, { path });
  return {
    address: acc.address,
    privateKey: acc.privateKey as string,
    path,
  };
}

export function isEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
