import { mnemonicToSeed, slip10DerivePath } from "./slip10.js";
import { privateKeyToRaw } from "./ed25519.js";
import { blake2b256 } from "../redact.js";

export type SuiAccount = { address: string; privateKey: Buffer; publicKey: Buffer; path: string };

export const DEFAULT_SUI_PATH = "m/44'/784'/0'/0'/0'";

export function suiAccountFromMnemonic(mnemonic: string, path: string = DEFAULT_SUI_PATH): SuiAccount {
  const seed = mnemonicToSeed(mnemonic, "");
  const node = slip10DerivePath(seed, path);
  const pub = privateKeyToRaw(node.privateKey);
  const addr = Buffer.from("00" + pub.toString("hex"), "hex");
  const hash = blake2b256(addr);
  return {
    address: "0x" + hash.toString("hex"),
    privateKey: node.privateKey,
    publicKey: pub,
    path,
  };
}

export function isSuiAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(addr);
}
