import { createPrivateKey, createPublicKey } from "node:crypto";

export function privateKeyToRaw(secret32: Buffer): Buffer {
  const priv = createPrivateKey({ key: secret32, format: "raw", type: "ed25519" } as any);
  const pub = createPublicKey(priv);
  const jwk = pub.export({ type: "jwk" } as any) as { x?: string };
  if (!jwk.x) throw new Error("failed to export ed25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

export function signEd25519(secret32: Buffer, message: Buffer): Buffer {
  const priv = createPrivateKey({ key: secret32, format: "raw", type: "ed25519" } as any);
  const { sign } = require("node:crypto");
  return Buffer.from(sign(null as any, priv, message));
}

export function verifyEd25519(pub32: Buffer, message: Buffer, signature: Buffer): boolean {
  const { createPublicKey, verify } = require("node:crypto");
  const pub = createPublicKey({ key: pub32, format: "raw", type: "ed25519" } as any);
  return verify(null as any, pub, message, signature);
}
