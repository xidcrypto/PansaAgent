import type { Tool } from "./agent.js";
import { createSignTool, createRejectTool, createListConfirmationsTool, createWalletListTool, createWalletCreateTool } from "./signer/tools.js";
import { createTrackerTool, createReportTool } from "./tracker/tools.js";
import { createBAWTool } from "./skills/baw.js";
import { createScamCheckTool } from "./research/index.js";
import { createSkillLoadTool } from "./skills/loader.js";
import { createPriceTool, createCexTool } from "./market/tools.js";
import { createSwapTool } from "./swap/tools.js";
import { runAnalyst } from "./analyst/run.js";
import { loadConfig } from "./config.js";
import { openPage } from "./browser/index.js";
import { McpClient } from "./mcp/client.js";

// Single wiring for the agent's tool set (B1/M3). The CLI and the TUI both
// build their Agent from this registry; the SkillsManager registry is a
// secondary programmatic API, not a second tool set.
// Gateway tool filter (owner-only safety): the gateway agent must never
// move money or sign. The baw tool can (transfer/swap/claim, plus
// list_wallets/balance reads), so it never reaches the gateway, and
// signing tools are removed too unless the testnet confirm path is
// explicitly enabled (execution still stays human-only).
// wallet_list/wallet_create deliberately STAY: they cannot move money
// or sign, they never return key material, and the gateway itself is
// owner-only (allowedUsers gate). wallet_list returns registry
// names+addresses only — public identifiers, never balances (balance
// reads stay behind the stripped baw tool). The old blanket rule
// "wallet ops stay in TUI/CLI" was superseded by the owner's explicit
// order to create wallets via Telegram; fund movement was NOT part of
// that order and stays out.
export function stripGatewayUnsafeTools(tools: Map<string, Tool>, opts: { allowConfirm: boolean }): void {
  tools.delete("baw");
  tools.delete("swap");
  if (!opts.allowConfirm) {
    tools.delete("sign_transaction");
    tools.delete("reject_transaction");
  }
}

export function buildAgentTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const list: Tool[] = [
    createSignTool(),
    createRejectTool(),
    createListConfirmationsTool(),
    createWalletListTool(),
    createWalletCreateTool(),
    createTrackerTool(),
    createReportTool(),
    createBAWTool(),
    createScamCheckTool(),
    createAnalystTool(),
    createPriceTool(),
    createCexTool(),
    createSwapTool(),
    createSkillLoadTool(),
    createBrowserTool(),
  ];
  for (const t of list) tools.set(t.name, t);
  return tools;
}

// Direct analyst tool for the agent. Without it the agent could only read
// skill docs via skill_load (which has no analyst doc) and could never
// actually audit a contract — it looped calling docs until the step cap.
export function createAnalystTool(): Tool {
  return {
    name: "analyst",
    description:
      "Audit a token/mint from on-chain evidence and return a CLEAR, CAUTION, TRAP, or UNVERIFIED verdict with checks. Use this tool (not skill_load) for any contract audit request. EVM contract address (0x…) or Solana mint (base58). Read-only, never signs.",
    parameters: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
    signs: false,
    execute: async (args: Record<string, unknown>) => {
      const res = await runAnalyst(String(args.address ?? ""));
      if (!res.ok) return { ok: false, data: null, error: res.error };
      return { ok: true, data: res.data };
    },
  };
}

// Optional browser tool. It exists in every agent's tool set but refuses
// unless config.browser is true, and fails honestly when playwright is
// not installed (optional peer) instead of pretending to browse.
export function createBrowserTool(): Tool {
  return {
    name: "browser_open",
    description: "Open a public web page and return its title and text (requires config.browser=true and the optional playwright peer).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    signs: false,
    execute: async (args: Record<string, unknown>) => {
      const cfg = loadConfig();
      if (!cfg.browser) {
        return { ok: false, data: null, error: "Browser dinonaktifkan di config (set browser: true untuk mengaktifkan)." };
      }
      const url = String(args.url ?? "");
      if (!/^https?:\/\//.test(url)) return { ok: false, data: null, error: "URL harus http(s)." };
      try {
        const snap = await openPage(url);
        return { ok: true, data: snap };
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// MCP-augmented tool set (U5). Starts from buildAgentTools() and merges
// one tool per MCP server tool, named mcp_<server>_<tool>. A dead or
// misconfigured server is skipped best-effort: it must never break the
// agent. Started clients are killed on process exit so one-shot runs do
// not leak orphaned server processes.
export async function buildAgentToolsWithMcp(): Promise<Map<string, Tool>> {
  const tools = buildAgentTools();
  let servers: Record<string, string> = {};
  try {
    servers = loadConfig().mcpServers ?? {};
  } catch {
    return tools;
  }
  for (const [server, command] of Object.entries(servers)) {
    try {
      const client = new McpClient(command);
      await client.start();
      process.once("exit", () => client.close());
      const defs = await client.listTools();
      for (const def of defs) {
        const name = `mcp_${server}_${def.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
        if (tools.has(name)) continue;
        tools.set(name, {
          name,
          description: `MCP tool ${server}/${def.name}: ${def.description ?? ""}`,
          parameters: (def.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          signs: false,
          execute: async (args: Record<string, unknown>) => {
            try {
              const result = await client.callTool(def.name, args);
              return { ok: true, data: result };
            } catch (err) {
              return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
            }
          },
        });
      }
    } catch {
      // Dead server: skip it, agent continues with the rest.
    }
  }
  return tools;
}
