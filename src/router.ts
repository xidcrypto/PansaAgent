import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { createInterface } from "node:readline";

const DEFAULT_PORT = 17070;
const PORT_MIN = 17070;
const PORT_MAX = 17090;

function resolveBansosRouter(): string {
  // Try local bansos-router first
  try {
    const fs = require("fs");
    const pkgPath = "/root/pansaagent/node_modules/bansos-router/package.json";
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const bin = pkg.bin;
      if (typeof bin === "string") return bin;
      if (bin && typeof bin === "object") {
        const entry = bin.main ?? (bin as any)?.bin ?? "";
        if (typeof entry === "string" && entry.length > 0) return entry;
      }
    }
  } catch {
    // fallback
}
  // Check global installation
  try {
    require.resolve("bansos-router");
    return "bansos-router";
  } catch {
    throw new Error("bansos-router not found");
  }
}

export function spawnDaemon(port: number = DEFAULT_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    const routerPath = resolveBansosRouter();
    const args = ["start", `--port=${port}`, "--bg"];
    const proc = spawn(execPath, [routerPath, ...args], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();

    const deadline = Date.now() + 5000;
    let resolved = false;
    const check = setInterval(() => {
      if (resolved) return;
      try {
        const net = require("node:net");
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
        const { exec } = require("child_process");
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

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require("node:net");
    const socket = new net.Socket();
    socket.on("error", () => resolve(true));
    socket.on("listening", () => {
      socket.destroy();
      resolve(false);
    });
    socket.listen(port, "127.0.0.1");
  });
}

export async function startWithPortBump(startPort: number = DEFAULT_PORT): Promise<number> {
  for (let port = startPort; port <= PORT_MAX; port++) {
    try {
      const available = await isPortAvailable(port);
      if (available) {
        return port;
      }
    } catch {
      // port in use, try next
    }
  }
  // Default: return MAX port + 1 if none available
  return PORT_MAX + 1;
}

export interface RouterConfig {
  port?: number;
  consent?: boolean;
}

export async function startDaemonWithConfig(config: RouterConfig = {}): Promise<number> {
  const port = config.port ?? DEFAULT_PORT;
  let selectedPort: number = port;

  const bumped = await startWithPortBump(selectedPort);
  if (bumped !== null) selectedPort = bumped;
  if (selectedPort === port) {
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      const bumped2 = await startWithPortBump(p);
      if (bumped2 !== null && bumped2 !== selectedPort) {
        selectedPort = bumped2;
        break;
      }
    }
  }

  if (selectedPort === port && config.consent !== false) {
    consentedInstall();
    const bumped3 = await startWithPortBump(port);
    if (bumped3 !== null) selectedPort = bumped3;
  }

  return selectedPort as number;
}