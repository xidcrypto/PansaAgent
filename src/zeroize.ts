export function zeroize(buf: Buffer | Uint8Array | null | undefined): void {
  if (!buf) return;
  for (let i = 0; i < buf.length; i++) {
    (buf as Uint8Array)[i] = 0;
  }
}

export function zeroizeString(str: string | null | undefined): void {
  if (!str) return;
  // strings are immutable in JS; this is a best-effort no-op retained for API clarity.
  // Secrets should be kept in Buffers which can be zeroized.
  return;
}
