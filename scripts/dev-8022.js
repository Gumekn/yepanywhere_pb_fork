#!/usr/bin/env node

/**
 * Development hot-reload entrypoint for the local 8022 deployment.
 *
 * This preserves the Codex bridge sidecar on 4510 and only replaces the
 * web/API process on 8022 when --replace is explicitly passed.
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exitIfUnsafeHome } from "./safe-home.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const DEFAULT_PORT = 8022;
const DEFAULT_BASE_PATH = "/yep";
const DEFAULT_CODEX_BRIDGE_PORT = 4510;

exitIfUnsafeHome({ entrypoint: "pnpm dev:8022" });

function showHelp() {
  console.log(`Usage: pnpm dev:8022 [options]

Options:
  --replace                    Stop the current 8022 web/API process first
  --allow-yep-session-interrupt
                               Allow replacing 8022 when Yep-managed sessions are active
  --no-backend-watch           Disable backend tsx watch reloads
  --no-frontend-reload         Disable frontend HMR and show reload banners
  --check                      Run preflight checks without starting or stopping anything
  -h, --help                   Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    replace: false,
    allowYepSessionInterrupt: false,
    backendWatch: true,
    noFrontendReload: false,
    check: false,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--allow-yep-session-interrupt") {
      options.allowYepSessionInterrupt = true;
    } else if (arg === "--no-backend-watch") {
      options.backendWatch = false;
    } else if (arg === "--no-frontend-reload") {
      options.noFrontendReload = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBasePath(value) {
  const raw = (value ?? DEFAULT_BASE_PATH).trim();
  if (!raw || raw === "/") return "";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function getListenPids(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split(/\s+/)
    .map((pid) => pid.trim())
    .filter(Boolean);
}

function getCommand(pid) {
  const result = spawnSync("ps", ["-p", pid, "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function setsOverlap(left, right) {
  const rightSet = new Set(right);
  return left.some((pid) => rightSet.has(pid));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortRelease(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getListenPids(port).length === 0) return true;
    await sleep(250);
  }
  return getListenPids(port).length === 0;
}

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

async function getWorkerActivity(serverBaseUrl) {
  try {
    return await fetchJson(`${serverBaseUrl}/api/status/workers`);
  } catch {
    return null;
  }
}

async function getBridgeStatus(bridgeControlUrl) {
  try {
    return await fetchJson(`${bridgeControlUrl}/status`);
  } catch {
    return null;
  }
}

function printPids(label, pids) {
  if (pids.length === 0) {
    console.log(`${label}: none`);
    return;
  }

  console.log(`${label}: ${pids.join(", ")}`);
  for (const pid of pids) {
    const command = getCommand(pid);
    if (command) console.log(`  ${pid}: ${command}`);
  }
}

async function stopServerPids(port, pids) {
  console.log(`Stopping web/API listener on ${port}: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch (error) {
      console.warn(
        `Failed to send SIGTERM to ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (await waitForPortRelease(port)) {
    return;
  }

  const remaining = getListenPids(port);
  throw new Error(
    `Port ${port} is still in use by ${remaining.join(", ")} after SIGTERM. Stop it manually or disable the LaunchAgent before starting dev hot reload.`,
  );
}

function startDevServer(env, options) {
  const devArgs = [join(rootDir, "scripts/dev.js")];
  if (options.backendWatch) devArgs.push("--watch");
  if (options.noFrontendReload) devArgs.push("--no-frontend-reload");

  const child = spawn(process.execPath, devArgs, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = parsePort(process.env.PORT, DEFAULT_PORT);
  const basePath = normalizeBasePath(process.env.BASE_PATH);
  const vitePort = parsePort(process.env.VITE_PORT, port + 2);
  const maintenancePort =
    process.env.MAINTENANCE_PORT === "0"
      ? 0
      : parsePort(process.env.MAINTENANCE_PORT, port + 1);
  const bridgePort = parsePort(
    process.env.YEP_CODEX_BRIDGE_PORT ?? process.env.CODEX_BRIDGE_PORT,
    DEFAULT_CODEX_BRIDGE_PORT,
  );
  const bridgeControlUrl =
    process.env.YEP_CODEX_BRIDGE_CONTROL_URL ??
    process.env.CODEX_BRIDGE_CONTROL_URL ??
    `http://127.0.0.1:${bridgePort}`;
  const serverBaseUrl = `http://127.0.0.1:${port}${basePath}`;

  const serverPids = getListenPids(port);
  const bridgePids = getListenPids(bridgePort);

  console.log("Yep Anywhere 8022 hot-reload preflight");
  console.log(`  server: ${serverBaseUrl}`);
  console.log(`  vite:   http://127.0.0.1:${vitePort}`);
  console.log(
    `  maint:  ${maintenancePort === 0 ? "disabled" : `http://127.0.0.1:${maintenancePort}`}`,
  );
  console.log(`  codex bridge: ${bridgeControlUrl}`);
  printPids(`  ${port} listener`, serverPids);
  printPids(`  ${bridgePort} listener`, bridgePids);

  if (bridgePids.length > 0 && setsOverlap(serverPids, bridgePids)) {
    throw new Error(
      `${bridgePort} is owned by the ${port} web/API process. Refusing to start hot reload because replacing ${port} would interrupt existing codex --remote sessions.`,
    );
  }

  const bridgeStatus = await getBridgeStatus(bridgeControlUrl);
  if (bridgeStatus) {
    console.log(
      `  bridge status: listening=${String(
        bridgeStatus.listening,
      )}, connections=${bridgeStatus.connectionCount ?? "unknown"}, sessions=${
        bridgeStatus.sessionCount ?? "unknown"
      }`,
    );
  } else if (bridgePids.length > 0) {
    console.warn(`  bridge status: ${bridgeControlUrl}/status did not answer`);
  } else {
    console.warn(`  bridge status: no listener on ${bridgePort}`);
  }

  if (options.check) {
    return;
  }

  if (serverPids.length > 0 && !options.replace) {
    throw new Error(
      `Port ${port} is already in use. Re-run with --replace to stop only the ${port} web/API process while preserving ${bridgePort}.`,
    );
  }

  if (serverPids.length > 0) {
    const activity = await getWorkerActivity(serverBaseUrl);
    if (activity?.hasActiveWork && !options.allowYepSessionInterrupt) {
      throw new Error(
        `Yep currently reports active managed work (${activity.activeWorkers} process(es), queue=${activity.queueLength}). Replacing ${port} would abort the active turn. Wait for it to finish or pass --allow-yep-session-interrupt.`,
      );
    }
    if (activity && activity.activeWorkers > 0 && !activity.hasActiveWork) {
      console.warn(
        `Yep reports ${activity.activeWorkers} idle managed process(es). They will be closed by the server restart, but no active turn is running.`,
      );
    }

    await stopServerPids(port, serverPids);

    const bridgePidsAfter = getListenPids(bridgePort);
    if (bridgePids.length > 0 && !setsOverlap(bridgePids, bridgePidsAfter)) {
      console.warn(
        `Codex bridge listener changed while replacing ${port}: before=${bridgePids.join(
          ",",
        )} after=${bridgePidsAfter.join(",") || "none"}`,
      );
    }
  }

  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    BASE_PATH: basePath || "/",
    MAINTENANCE_PORT: String(maintenancePort),
    VITE_PORT: String(vitePort),
    VITE_API_PORT: String(port),
    YEP_CODEX_BRIDGE_MODE: "external",
    YEP_CODEX_BRIDGE_CONTROL_URL: bridgeControlUrl,
    YEP_CODEX_BRIDGE_PORT: String(bridgePort),
  };

  console.log(
    `Starting hot reload on ${serverBaseUrl} (${options.backendWatch ? "backend watch" : "manual backend reload"}, ${options.noFrontendReload ? "frontend manual reload" : "frontend HMR"})`,
  );
  startDevServer(env, options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
