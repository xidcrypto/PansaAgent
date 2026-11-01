import { mnemonicToSeed, slip10DerivePath } from "./slip10.js";
import { privateKeyToRaw } from "./ed25519.js";
import { base58encode } from "../redact.js";

export type SolanaAccount = { address: string; privateKey: Buffer; publicKey: Buffer; path: string };

export const DEFAULT_SOLANA_PATH = "m/44'/501'/0'/0'";

export function solanaAccountFromMnemonic(
  mnemonic: string,
  path: string = DEFAULT_SOLANA_PATH,
): SolanaAccount {
  const seed = mnemonicToSeed(mnemonic, "");
  const node = slip10DerivePath(seed, path);
  const pub = privateKeyToRaw(node.privateKey);
  return {
    address: base58encode(pub),
    privateKey: node.privateKey,
    publicKey: pub,
    path,
  };
}

export function isSolanaAddress(addr: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  } catch {
    return false;
  }
}
