import { fork, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type SignerRequest = { id: unknown; method: string; params?: Record<string, unknown> };
export type SignerResponse = { id: unknown; ok: boolean; result?: unknown; error?: string };

export class SignerClient {
  private proc: ChildProcess;
  private pending = new Map<unknown, { resolve: (v: SignerResponse) => void; reject: (e: Error) => void }>();
  private id = 0;
  private readonly lineStream: ReturnType<typeof createInterface>;

  constructor(scriptPath: string, passphrase?: string) {
    const env: Record<string, string> = { ...process.env, PANSA_SIGNER_SERVER: "1" };
    if (passphrase) env.PANSA_PASSPHRASE = passphrase;
    this.proc = fork(scriptPath, [], { env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    this.lineStream = createInterface({ input: this.proc.stdout as NodeJS.ReadableStream, terminal: false });
    this.lineStream.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let res: SignerResponse;
      try { res = JSON.parse(trimmed); } catch { return; }
      const cb = this.pending.get(res.id);
      if (cb) {
        this.pending.delete(res.id);
        if (res.ok) cb.resolve(res);
        else cb.reject(new Error(res.error ?? "signer error"));
      }
    });
    this.proc.on("exit", (code) => {
      for (const cb of this.pending.values()) {
        cb.reject(new Error(`signer process exited with code ${code}`));
      }
      this.pending.clear();
    });
    this.proc.stderr?.on("data", () => { /* ignore signer stderr */ });
  }

  request(method: string, params?: Record<string, unknown>): Promise<SignerResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, method, params }) + "\n";
      try {
        this.proc.stdin?.write(line);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}
