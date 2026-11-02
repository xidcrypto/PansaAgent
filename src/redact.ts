import * as sha256mod from "@noble/hashes/sha256";
import * as blake2bmod from "@noble/hashes/blake2b";
import { wordlist as BIP39_WORDLIST } from "@scure/bip39/wordlists/english";

const BOT_TOKEN = /\b\d{6,}:[\w-]{30,}\b/g;
const B58 = /\b[1-9A-HJ-NP-Za-km-z]{64,90}\b/g;
// Mnemonic candidates: 12-24 lowercase words. A candidate is redacted
// ONLY if every word is on the BIP39 English list and the count is a
// valid mnemonic length — plain prose must survive (M5).
const BIP39 = new Set<string>(BIP39_WORDLIST);
// Valid BIP39 mnemonic lengths, longest first so a 24-word phrase is
// consumed whole instead of as two 12-word halves.
const MNEMONIC_LENGTHS = [24, 21, 18, 15, 12];

function redactMnemonics(text: string): string {
  // Scan each maximal run of lowercase words; greedily redact the
  // longest valid-length all-BIP39 window starting at each position.
  // Normal prose survives because its words are not all on the list, and
  // a valid mnemonic embedded in surrounding words is still caught.
  return text.replace(/[a-z]{3,}(?:\s+[a-z]{3,})+/g, (run) => {
    const words = run.split(/\s+/);
    let out = "";
    let changed = false;
    let i = 0;
    while (i < words.length) {
      let matched = false;
      for (const len of MNEMONIC_LENGTHS) {
        if (i + len <= words.length && words.slice(i, i + len).every((w) => BIP39.has(w))) {
          out += (out ? " " : "") + "[REDACTED MNEMONIC]";
          i += len;
          matched = true;
          changed = true;
          break;
        }
      }
      if (!matched) {
        out += (out ? " " : "") + words[i];
        i++;
      }
    }
    return changed ? out : run;
  });
}

export function redact(text: unknown): string {
  if (typeof text !== "string") return String(text);
  // NOTE: 0x + 64 hex (transaction hashes) is deliberately NOT redacted:
  // legit hashes must survive logs and history (M5).
  return redactMnemonics(
    text
      .replace(BOT_TOKEN, "[REDACTED BOT TOKEN]")
      .replace(B58, "[REDACTED BASE58]"),
  );
}

export function redactObj<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactObj) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactObj(v);
    return out as unknown as T;
  }
  return value;
}

export function isBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) && s.length >= 4;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

export function base58encode(data: Buffer): string {
  const input = Buffer.from(data);
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === 0) leadingZeros++;
  let digits: number[] = [0];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      digits[i] = digits[i] * 256 + carry;
      carry = Math.floor(digits[i] / 58);
      digits[i] %= 58;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i];
    result += B58_ALPHABET[d ?? 0];
  }
  return result;
}

export function base58decode(str: string): Buffer | null {
  let leadingOnes = 0;
  for (const ch of str) { if (ch !== "1") break; leadingOnes++; }
  let bytes: number[] = [0];
  for (const ch of str) {
    const idx = B58_MAP[ch];
    if (idx === undefined) return null;
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = bytes[i] * 58 + carry;
      carry = Math.floor(bytes[i] / 256);
      bytes[i] %= 256;
    }
    while (carry > 0) {
      bytes.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }
  while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
  bytes.reverse();
  return Buffer.from([...Array(leadingOnes).fill(0), ...bytes]);
}

export const sha256 = (data: Buffer | string): Buffer => {
  const h = sha256mod.sha256(Buffer.from(data));
  return Buffer.from(h);
};

export const blake2b256 = (data: Buffer | string): Buffer => {
  const h = blake2bmod.blake2b(Buffer.from(data), { dkLen: 32 });
  return Buffer.from(h);
};
