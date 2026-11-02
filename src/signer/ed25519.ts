import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// Ed25519 keys via DER (RFC 8410). Node's createPrivateKey/createPublicKey
// do not accept format "raw", and a JWK private key requires the public
// component too — which is exactly what privateKeyToRaw derives. The DER
// wrappers below are fixed prefixes, not key material.
//
// PKCS#8 private:  SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 },
//   OCTET STRING { OCTET STRING secret } }
// SPKI public:     SEQUENCE { SEQUENCE { OID 1.3.101.112 },
//   BIT STRING { 0x00, public } }
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyObject(secret32: Buffer) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secret32]), format: "der", type: "pkcs8" });
}

function publicKeyObject(pub32: Buffer) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub32]), format: "der", type: "spki" });
}

export function privateKeyToRaw(secret32: Buffer): Buffer {
  const pub = createPublicKey(privateKeyObject(secret32));
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.from(der.subarray(SPKI_PREFIX.length));
}

export function signEd25519(secret32: Buffer, message: Buffer): Buffer {
  return Buffer.from(sign(null, message, privateKeyObject(secret32)));
}

export function verifyEd25519(pub32: Buffer, message: Buffer, signature: Buffer): boolean {
  return verify(null, message, publicKeyObject(pub32), signature);
}
