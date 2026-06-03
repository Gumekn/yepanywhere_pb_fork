import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

// Session file stores the path to the unique temp directory for this test run
const SESSION_FILE = join(tmpdir(), "claude-e2e-session");

/**
 * Get the temp directory for this test run from the session file.
 */
function getTempDir(): string {
  if (existsSync(SESSION_FILE)) {
    const tempDir = readFileSync(SESSION_FILE, "utf-8").trim();
    if (tempDir && existsSync(tempDir)) {
      return tempDir;
    }
  }
  throw new Error(
    `Session file not found or invalid: ${SESSION_FILE}. Did global-setup run?`,
  );
}

/**
 * Read a port from a file in the temp directory.
 */
function getPort(filename: string, description: string): number {
  const tempDir = getTempDir();
  const portFile = join(tempDir, filename);
  if (existsSync(portFile)) {
    return Number.parseInt(readFileSync(portFile, "utf-8"), 10);
  }
  throw new Error(
    `${description} port file not found: ${portFile}. Did global-setup run?`,
  );
}

function getServerPort(): number {
  return getPort("port", "Server");
}

function getMaintenancePort(): number {
  return getPort("maintenance-port", "Maintenance");
}

interface E2EPaths {
  tempDir: string;
  testDir: string;
  claudeSessionsDir: string;
  codexSessionsDir: string;
  geminiSessionsDir: string;
  dataDir: string;
}

function getTestPaths(): E2EPaths {
  const tempDir = getTempDir();
  const pathsFile = join(tempDir, "paths.json");
  if (existsSync(pathsFile)) {
    return JSON.parse(readFileSync(pathsFile, "utf-8"));
  }
  throw new Error(`Paths file not found: ${pathsFile}. Did global-setup run?`);
}

// Export paths for tests to use instead of hardcoded homedir() paths
export const e2ePaths = {
  get tempDir() {
    return getTestPaths().tempDir;
  },
  get testDir() {
    return getTestPaths().testDir;
  },
  get claudeSessionsDir() {
    return getTestPaths().claudeSessionsDir;
  },
  get codexSessionsDir() {
    return getTestPaths().codexSessionsDir;
  },
  get geminiSessionsDir() {
    return getTestPaths().geminiSessionsDir;
  },
  get dataDir() {
    return getTestPaths().dataDir;
  },
};

// Extended test fixtures
interface TestFixtures {
  baseURL: string;
  maintenanceURL: string;
  wsURL: string;
}

// Extend base test with dynamic baseURL and maintenanceURL
export const test = base.extend<TestFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  baseURL: async ({}, use) => {
    const port = getServerPort();
    await use(`http://localhost:${port}`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  maintenanceURL: async ({}, use) => {
    const port = getMaintenancePort();
    await use(`http://localhost:${port}`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture pattern requires empty destructure
  wsURL: async ({}, use) => {
    const port = getServerPort();
    await use(`ws://localhost:${port}/api/ws`);
  },
});

export { expect } from "@playwright/test";
