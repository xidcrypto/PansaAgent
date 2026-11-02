// Resolves the signer server entry point (the CLI itself). In production
// this module is bundled into dist/cli.js, so import.meta.url IS the
// bundle and main() routes PANSA_SIGNER_SERVER=1 to runStdio. In dev
// (tsx) the entry is src/cli.ts, run through the tsx CLI (B14).
// Kept here (not in cli.ts) so the TUI can use the signer without a
// cli <-> ui import cycle.
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveSignerEntry(): { file: string; args: string[] } {
  const entry = fileURLToPath(import.meta.url);
  if (!entry.endsWith(".ts")) return { file: entry, args: [] };
  const cliTs = join(dirname(entry), "..", "cli.ts");
  const tsxCli = join(dirname(entry), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsxCli)) return { file: tsxCli, args: [cliTs] };
  return { file: "tsx", args: [cliTs] };
}
