// Post-build step: make the bundled CLI executable. No dependencies.
// Runs from the package root (npm run build); safe to re-run.
import { chmodSync, existsSync } from "node:fs";

const target = "dist/cli.js";
if (existsSync(target)) {
  chmodSync(target, 0o755);
}
