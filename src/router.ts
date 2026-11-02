import { spawn, exec } from "node:child_process";
import { execPath } from "node:process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_PORT = 17070;
const PORT_MIN = 17070;
const PORT_MAX = 17090;

// Resolve the bansos-router CLI entry. Preferred: Node's own resolution
// from this module (handles hoisting and installed layouts correctly).
// Fallback: walk up from this module (dev layouts, bundled copies).
// The bin entry prefers the "bansos" key when bin is an object (U1.5).
export function resolveBansosRouter(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("bansos-router/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = pkg.bin;
    const entry =
      typeof bin === "string"
        ? bin
        : bin && typeof bin === "object"
          ? (bin["bansos"] ?? Object.values(bin)[0])
          : undefined;
    if (typeof entry === "string" && entry.length > 0) return join(dirname(pkgPath), entry);
  } catch {
    // fall through to the walk-up fallback
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkgDir = join(dir, "node_modules", "bansos-router");
    const pkgPath = join(pkgDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
        const bin = pkg.bin;
        const entry =
          typeof bin === "string"
            ? bin
            : bin && typeof bin === "object"
              ? (bin["bansos"] ?? Object.values(bin)[0])
              : undefined;
        if (typeof entry === "string" && entry.length > 0) return join(pkgDir, entry);
      } catch {
        // fall through to the PATH name
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "bansos-router";
}

// Spawn helper shared by the router module and llm.ensureDaemon: a bare
// name runs from PATH; a resolved file path runs under node.
export function spawnRouter(args: string[]): ReturnType<typeof spawn> {
  const routerPath = resolveBansosRouter();
  return routerPath === "bansos-router"
    ? spawn(routerPath, args, { stdio: "ignore", detached: true })
    : spawn(execPath, [routerPath, ...args], { stdio: "ignore", detached: true });
}

export function spawnDaemon(port: number = DEFAULT_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["start", `--port=${port}`, "--bg"];
    const proc = spawnRouter(args);
    proc.unref();

    const deadline = Date.now() + 5000;
    let resolved = false;
    const check = setInterval(() => {
      if (resolved) return;
      try {
        const socket = new net.Socket();
        socket.connect(port, "127.0.0.1", () => {
          socket.destroy();
          clearInterval(check);
          resolved = true;
          resolve();
        });
        socket.on("error", () => socket.destroy());
        if (Date.now() > deadline) {
          clearInterval(check);
          resolved = true;
          reject(new Error("bansos-router did not start in time"));
        }
      } catch {
        if (Date.now() > deadline) {
          clearInterval(check);
          resolved = true;
          reject(new Error("bansos-router did not start in time"));
        }
      }
    }, 200);
  });
}

export function consentedInstall(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(
    "Install bansos-router globally? (y/N): ",
    (answer: string) => {
      if (answer.toLowerCase() === "y") {
        exec("npm i -g bansos-router", (err: unknown) => {
          if (err) process.stderr.write(`Install failed: ${String(err)}\n`);
          else process.stdout.write("Installed bansos-router globally.\n");
          rl.close();
        });
      } else {
        process.stderr.write("Global install cancelled.\n");
        rl.close();
      }
    }
  );
}

// True when the port is FREE (bindable). The old implementation called
// .listen() on a Socket, which has no such method.
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

// First free port in [startPort, PORT_MAX], or null when none is free.
export async function startWithPortBump(startPort: number = DEFAULT_PORT): Promise<number | null> {
  for (let port = startPort; port <= PORT_MAX; port++) {
    try {
      if (await isPortAvailable(port)) return port;
    } catch {
      // port in use, try next
    }
  }
  return null;
}

export interface RouterConfig {
  port?: number;
  consent?: boolean;
}

export async function startDaemonWithConfig(config: RouterConfig = {}): Promise<number> {
  const port = config.port ?? DEFAULT_PORT;
  const bumped = await startWithPortBump(port);
  if (bumped !== null) return bumped;
  const full = await startWithPortBump(PORT_MIN);
  if (full !== null) return full;
  throw new Error(`No free port in ${PORT_MIN}-${PORT_MAX} for bansos-router`);
}
