import { createHash } from "node:crypto";
import { mnemonicToSeed, slip10DerivePath } from "./slip10.js";
import { privateKeyToRaw } from "./ed25519.js";

export type AptosAccount = { address: string; privateKey: Buffer; publicKey: Buffer; path: string };

export const DEFAULT_APTOS_PATH = "m/44'/637'/0'/0'/0'";

export function aptosAccountFromMnemonic(
  mnemonic: string,
  path: string = DEFAULT_APTOS_PATH,
): AptosAccount {
  const seed = mnemonicToSeed(mnemonic, "");
  const node = slip10DerivePath(seed, path);
  const pub = privateKeyToRaw(node.privateKey);
  const data = Buffer.concat([pub, Buffer.from([0x00])]);
  const hash = createHash("sha3-256").update(data).digest();
  return {
    address: "0x" + hash.toString("hex"),
    privateKey: node.privateKey,
    publicKey: pub,
    path,
  };
}

export function isAptosAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(addr);
}
