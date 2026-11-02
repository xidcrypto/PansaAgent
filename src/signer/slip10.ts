import { pbkdf2Sync, createHmac, timingSafeEqual } from "node:crypto";

// ed25519 curve order l = 2^252 + 27742317777372353535851937790883648493
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

export function mnemonicToSeed(mnemonic: string, passphrase: string): Buffer {
  const salt = Buffer.from("mnemonic" + passphrase, "utf8");
  return pbkdf2Sync(mnemonic, salt, 2048, 64, "sha512");
}

function modAdd(a: Buffer, b: Buffer): Buffer {
  const av = bufferToBigInt(a);
  const bv = bufferToBigInt(b);
  const r = (av + bv) % ED25519_L;
  return bigIntToBuffer(r);
}

function bufferToBigInt(buf: Buffer): bigint {
  return 0n + BigInt("0x" + buf.toString("hex"));
}

function bigIntToBuffer(n: bigint): Buffer {
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

export interface Slip10Node {
  privateKey: Buffer;
  chainCode: Buffer;
  depth: number;
  index: number;
  // Fingerprint is intentionally always zero (D7): PANSA derives only
  // hardened ed25519 paths and never serializes extended keys, so no
  // parent fingerprint is ever needed. It is kept in the shape for
  // SLIP-10 compatibility, not computed.
  fingerprint: Buffer;
}

export function slip10Master(seed: Buffer): Slip10Node {
  const h = createHmac("sha512", Buffer.from("ed25519 seed", "utf8")).update(seed).digest();
  return {
    privateKey: h.slice(0, 32),
    chainCode: h.slice(32, 64),
    depth: 0,
    index: 0,
    fingerprint: Buffer.alloc(4, 0),
  };
}

export function slip10Derive(parent: Slip10Node, index: number): Slip10Node {
  const hardened = index >= 0x80000000;
  const data = Buffer.alloc(37);
  data[0] = hardened ? 0 : 2;
  if (hardened) {
    parent.privateKey.copy(data, 1);
  } else {
    // normal derivation needs public key; all target paths are hardened
    throw new Error("non-hardened derivation not implemented for slip10 ed25519");
  }
  data.writeUInt32BE(index, 33);
  const h = createHmac("sha512", parent.chainCode).update(data).digest();
  const childPrivate = modAdd(parent.privateKey, h.slice(0, 32));
  return {
    privateKey: childPrivate,
    chainCode: h.slice(32, 64),
    depth: parent.depth + 1,
    index,
    fingerprint: Buffer.alloc(4, 0),
  };
}

export function slip10DerivePath(seed: Buffer, path: string): Slip10Node {
  let node = slip10Master(seed);
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts[0] === "m") parts.shift();
  for (const part of parts) {
    // Validate the segment before any arithmetic: parseInt("abc") is NaN
    // and used to explode inside writeUInt32BE with a useless message.
    const m = /^(\d+)('?)$/.exec(part);
    if (!m) {
      throw new Error(`Invalid derivation path segment: "${part}" in path "${path}" (expected <number> or <number>')`);
    }
    const base = Number(m[1]);
    if (!Number.isInteger(base) || base < 0 || base >= 0x80000000) {
      throw new Error(`Invalid derivation index: "${part}" in path "${path}" (must be 0 <= index < 2^31)`);
    }
    const index = m[2] === "'" ? base + 0x80000000 : base;
    try {
      node = slip10Derive(node, index);
    } catch (err) {
      throw new Error(`Cannot derive segment "${part}" in path "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return node;
}

export function equal(a: Buffer, b: Buffer): boolean {
  // Length-hiding compare (same rationale as crypto.constantTimeCompare).
  const len = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  a.copy(paddedA);
  b.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}
