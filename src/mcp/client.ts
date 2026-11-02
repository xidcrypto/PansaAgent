import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Minimal MCP client: JSON-RPC 2.0 over NDJSON on a child process's stdio.
// The server command comes from config mcpServers (a command line, e.g.
// "npx -y @modelcontextprotocol/server-memory"). A dead server fails
// fast; callers treat that as "server unavailable", never as a crash.
export class McpClient {
  private proc: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private buffer = "";
  private closed = false;

  constructor(private command: string) {}

  async start(timeoutMs = 10000): Promise<void> {
    const parts = this.command.trim().split(/\s+/).filter(Boolean);
    const [cmd, ...args] = parts;
    if (!cmd) throw new Error("Perintah MCP kosong");
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    const proc = this.proc;
    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    const failAll = (err: Error) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    proc.on("error", (err) => failAll(err instanceof Error ? err : new Error(String(err))));
    proc.on("exit", () => failAll(new Error("MCP server exited")));
    await this.request(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pansa", version: "0.1.0" } },
      timeoutMs,
    );
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
            else p.resolve(msg.result);
          }
        }
      } catch {
        // Malformed line: ignore, keep parsing the rest.
      }
    }
  }

  private notify(method: string, params: unknown): void {
    try {
      this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // Server gone; the next request fails with a clear error.
    }
  }

  request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    const proc = this.proc;
    if (!proc || this.closed) return Promise.reject(new Error("MCP server tidak berjalan"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    try {
      this.proc?.kill();
    } catch {
      // Already gone.
    }
    this.proc = null;
    this.closed = true;
  }
}
