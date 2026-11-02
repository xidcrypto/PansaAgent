import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { zeroize } from "./zeroize.js";

const SALT_LEN = 16;
const IV_LEN = 12;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
// One shared maxmem formula for encrypt and decrypt (D2). The value is a
// ceiling, not an allocation; it must stay well above scrypt's working
// set (~128 * N * r bytes).
function scryptMaxMem(N: number, r: number): number {
  return N * r * 16 * 1024 * 1024;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  scrypt: { N: number; r: number; p: number; keylen: number };
}

export function encrypt(plaintext: Buffer, passphrase: string): EncryptedPayload {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: scryptMaxMem(SCRYPT_N, SCRYPT_R),
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("pansa-v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  zeroize(key);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    salt: salt.toString("base64"),
    scrypt: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN },
  };
}

export function decrypt(payload: EncryptedPayload, passphrase: string): Buffer {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: payload.scrypt.N ?? SCRYPT_N,
    r: payload.scrypt.r ?? SCRYPT_R,
    p: payload.scrypt.p ?? SCRYPT_P,
    maxmem: scryptMaxMem(payload.scrypt.N ?? SCRYPT_N, payload.scrypt.r ?? SCRYPT_R),
  });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from("pansa-v1", "utf8"));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  zeroize(key);
  return plaintext;
}

export function verifyPassphrase(payload: EncryptedPayload, passphrase: string): boolean {
  try {
    decrypt(payload, passphrase);
    return true;
  } catch {
    return false;
  }
}

export function constantTimeCompare(a: Buffer, b: Buffer): boolean {
  // Length-hiding: always compare max(len) bytes, so an early return on
  // length mismatch cannot leak the expected length (D3).
  const len = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  a.copy(paddedA);
  b.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}
