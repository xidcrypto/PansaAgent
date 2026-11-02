import type { Tool } from "./agent.js";
import { createSignTool, createRejectTool, createListConfirmationsTool } from "./signer/tools.js";
import { createTrackerTool, createReportTool } from "./tracker/tools.js";
import { createBAWTool } from "./skills/baw.js";
import { createScamCheckTool } from "./research/index.js";

// Single wiring for the agent's tool set (B1/M3). The CLI and the TUI both
// build their Agent from this registry; the SkillsManager registry is a
// secondary programmatic API, not a second tool set.
export function buildAgentTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const list: Tool[] = [
    createSignTool(),
    createRejectTool(),
    createListConfirmationsTool(),
    createTrackerTool(),
    createReportTool(),
    createBAWTool(),
    createScamCheckTool(),
  ];
  for (const t of list) tools.set(t.name, t);
  return tools;
}
