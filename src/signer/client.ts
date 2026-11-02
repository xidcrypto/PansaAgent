import { fork, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveSignerEntry } from "./entry.js";

export type SignerRequest = { id: unknown; method: string; params?: Record<string, unknown> };
export type SignerResponse = { id: unknown; ok: boolean; result?: unknown; error?: string };

// Per-request timeout (B14): a hung signer child must fail loudly instead
// of hanging the CLI forever.
const REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_ID = "__ping__";

export class SignerClient {
  private proc: ChildProcess;
  private pending = new Map<unknown, { resolve: (v: SignerResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private id = 0;
  private readonly lineStream: ReturnType<typeof createInterface>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private ready: Promise<void>;
  private handshakeTimer: ReturnType<typeof setTimeout>;

  constructor(scriptPath: string, passphrase?: string, args: string[] = []) {
    const env: Record<string, string> = { ...process.env, PANSA_SIGNER_SERVER: "1" };
    if (passphrase) env.PANSA_PASSPHRASE = passphrase;
    this.proc = fork(scriptPath, args, { env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.handshakeTimer = setTimeout(() => {
      this.readyReject(new Error("signer handshake timed out (no ping response in 30s)"));
    }, REQUEST_TIMEOUT_MS);
    this.handshakeTimer.unref?.();
    this.lineStream = createInterface({ input: this.proc.stdout as NodeJS.ReadableStream, terminal: false });
    this.lineStream.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let res: SignerResponse;
      try { res = JSON.parse(trimmed); } catch { return; }
      if (res.id === HANDSHAKE_ID) {
        clearTimeout(this.handshakeTimer);
        if (res.ok) this.readyResolve();
        else this.readyReject(new Error(res.error ?? "signer handshake failed"));
        return;
      }
      const cb = this.pending.get(res.id);
      if (cb) {
        clearTimeout(cb.timer);
        this.pending.delete(res.id);
        if (res.ok) cb.resolve(res);
        else cb.reject(new Error(res.error ?? "signer error"));
      }
    });
    this.proc.on("exit", (code) => {
      clearTimeout(this.handshakeTimer);
      this.readyReject(new Error(`signer process exited with code ${code}`));
      for (const cb of this.pending.values()) {
        clearTimeout(cb.timer);
        cb.reject(new Error(`signer process exited with code ${code}`));
      }
      this.pending.clear();
    });
    // Forward the child's stderr so signer failures are visible instead of
    // swallowed (B14). Stdout stays the RPC channel and is never forwarded.
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    // Ping handshake: proves the child booted and speaks the RPC protocol
    // before any real request is sent.
    try {
      this.proc.stdin?.write(JSON.stringify({ id: HANDSHAKE_ID, method: "ping" }) + "\n");
    } catch (err) {
      this.readyReject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<SignerResponse> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signer request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ id, method, params }) + "\n";
      try {
        this.proc.stdin?.write(line);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

// Shared signer client for the CLI and the TUI (U3: /wallet new and the
// deterministic TUI commands must use the same signer process channel,
// not touch keystore files directly).
let sharedClient: SignerClient | null = null;

export function getSignerClient(): SignerClient {
  if (!sharedClient) {
    const { file, args } = resolveSignerEntry();
    sharedClient = new SignerClient(file, process.env.PANSA_PASSPHRASE, args);
  }
  return sharedClient;
}

export function closeSignerClient(): void {
  if (sharedClient) {
    try { sharedClient.close(); } catch { /* ignore */ }
    sharedClient = null;
  }
}
