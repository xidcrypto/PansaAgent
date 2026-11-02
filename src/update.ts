import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

// The installed version, read from the nearest package.json walking up
// from this module. Never imported as JSON (a bundled import would freeze
// the version at build time, not install time).
export function readOwnVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "pansa-agent" && pkg.version) return pkg.version;
    } catch {
      // Not the package root yet.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

// Numeric dotted-version comparison (no semver dependency): 1 if a > b,
// -1 if a < b, 0 if equal. Pre-release suffixes are ignored.
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

// Check the npm registry for a newer pansa-agent. Print-only contract:
// the caller prints an install command; nothing is installed or sent
// (no telemetry, no auto-update).
export async function checkUpdate(fetchFn: typeof fetch = fetch): Promise<UpdateInfo> {
  const current = readOwnVersion();
  try {
    const res = await fetchFn("https://registry.npmjs.org/pansa-agent/latest", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { current, latest: null, updateAvailable: false };
    const data = (await res.json()) as { version?: string };
    const latest = data.version ?? null;
    return {
      current,
      latest,
      updateAvailable: latest !== null && compareVersions(latest, current) > 0,
    };
  } catch {
    return { current, latest: null, updateAvailable: false };
  }
}
