import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import * as sha3 from "@noble/hashes/sha3";
import { zeroize } from "../zeroize.js";

// Ethereum keystore V3 (the format MetaMask/Rabby import): the private
// key is encrypted with a key derived from the USER'S wallet password
// (scrypt + AES-128-CTR + Keccak MAC). The plaintext key never leaves
// the signer process — the gateway only ever handles this JSON.
// Production KDF parameters follow the common default (n=262144); weaker
// parameters may be injected ONLY via the optional `params` argument
// (used by tests for speed), mirroring src/crypto.ts.
export interface V3Keystore {
  version: 3;
  id: string;
  address: string;
  crypto: {
    ciphertext: string;
    cipherparams: { iv: string };
    cipher: "aes-128-ctr";
    kdf: "scrypt";
    kdfparams: { dklen: 32; salt: string; n: number; r: number; p: number };
    mac: string;
  };
}

export interface V3Params {
  n?: number;
  r?: number;
  p?: number;
  salt?: Buffer;
  iv?: Buffer;
}

const V3_N = 262144;
const V3_R = 8;
const V3_P = 1;

function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, 32, { N: n, r, p, maxmem: 1024 * 1024 * 1024 });
}

function privateKeyBytes(privateKey: string | Buffer): Buffer {
  if (Buffer.isBuffer(privateKey)) {
    if (privateKey.length !== 32) throw new Error("private key must be 32 bytes");
    return Buffer.from(privateKey);
  }
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== 32) throw new Error("private key must be 32 bytes");
  return bytes;
}

export function buildV3Keystore(address: string, privateKey: string | Buffer, password: string, params: V3Params = {}): V3Keystore {
  const n = params.n ?? V3_N;
  const r = params.r ?? V3_R;
  const p = params.p ?? V3_P;
  const salt = params.salt ?? randomBytes(32);
  const iv = params.iv ?? randomBytes(16);
  const keyBytes = privateKeyBytes(privateKey);
  const derivedKey = deriveKey(password, salt, n, r, p);
  const ciphertext = (() => {
    const cipher = createCipheriv("aes-128-ctr", derivedKey.subarray(0, 16), iv);
    return Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  })();
  const mac = Buffer.from(sha3.keccak_256(Buffer.concat([derivedKey.subarray(16, 32), ciphertext])));
  zeroize(derivedKey);
  zeroize(keyBytes);
  return {
    version: 3,
    id: randomUUID(),
    address: address.startsWith("0x") ? address.slice(2).toLowerCase() : address.toLowerCase(),
    crypto: {
      ciphertext: ciphertext.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      cipher: "aes-128-ctr",
      kdf: "scrypt",
      kdfparams: { dklen: 32, salt: salt.toString("hex"), n, r, p },
      mac: mac.toString("hex"),
    },
  };
}

// Test/verify counterpart: throws on a wrong password or tampered file
// (MAC mismatch), so a bad password can never yield a wrong key.
export function decryptV3Keystore(keystore: V3Keystore, password: string): Buffer {
  const c = keystore.crypto;
  if (c.cipher !== "aes-128-ctr" || c.kdf !== "scrypt") throw new Error("unsupported keystore format");
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  const iv = Buffer.from(c.cipherparams.iv, "hex");
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = Buffer.from(c.mac, "hex");
  const derivedKey = deriveKey(password, salt, c.kdfparams.n, c.kdfparams.r, c.kdfparams.p);
  const expectedMac = Buffer.from(sha3.keccak_256(Buffer.concat([derivedKey.subarray(16, 32), ciphertext])));
  if (mac.length !== expectedMac.length || !timingSafeEqual(mac, expectedMac)) {
    zeroize(derivedKey);
    throw new Error("keystore MAC mismatch (wrong password or tampered file)");
  }
  const decipher = createDecipheriv("aes-128-ctr", derivedKey.subarray(0, 16), iv);
  const keyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  zeroize(derivedKey);
  return keyBytes;
}
