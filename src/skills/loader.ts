// Progressive disclosure for skill docs (U2.9): SKILL.md files live in
// <package>/skills/<name>/SKILL.md and are loaded on demand by the agent
// through the skill_load tool. Names are allowlisted (no path traversal);
// content is redacted before it reaches the model.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { redact } from "../redact.js";
import type { Tool } from "../agent.js";

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Walk up from this module to the package root (works in dev src/ and in
// the bundled dist/ layout, where skills/ sits next to dist/).
export function skillsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, "skills");
    if (isDir(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function listSkillDocs(): string[] {
  const dir = skillsDir();
  if (!dir) return [];
  try {
    return readdirSync(dir).filter((entry) => {
      try {
        return statSync(join(dir, entry, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export interface SkillDocResult {
  ok: boolean;
  name: string;
  content?: string;
  error?: string;
}

export function loadSkillDoc(name: string): SkillDocResult {
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return { ok: false, name, error: "invalid skill name" };
  }
  const dir = skillsDir();
  if (!dir) return { ok: false, name, error: "skills directory not found" };
  const file = join(dir, name, "SKILL.md");
  if (!existsSync(file)) return { ok: false, name, error: `skill not found: ${name}` };
  try {
    return { ok: true, name, content: redact(readFileSync(file, "utf8")) };
  } catch (err) {
    return { ok: false, name, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createSkillLoadTool(): Tool {
  return {
    name: "skill_load",
    description: "Load a skill doc (SKILL.md) by name before a multi-step task. Names: baw, dev, mint, report, scam-check, scout, testnet, tracker.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    execute: async (args: Record<string, unknown>) => {
      const name = String(args["name"] ?? "");
      const res = loadSkillDoc(name);
      if (!res.ok) return { ok: false, data: null, error: res.error };
      return { ok: true, data: { name: res.name, content: res.content } };
    },
  };
}
