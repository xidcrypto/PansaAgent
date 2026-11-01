import { generateMnemonic as gen } from "@scure/bip39";
import { wordlist as wl } from "@scure/bip39/wordlists/english";

export function generateMnemonic(strength: 128 | 160 | 192 | 224 | 256 = 128): string {
  return gen(wl, strength);
}
