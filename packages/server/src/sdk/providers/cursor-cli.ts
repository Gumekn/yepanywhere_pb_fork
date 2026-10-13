import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function findCursorAgentPath(): Promise<string | null> {
  for (const path of [
    process.env.YEP_CURSOR_AGENT_PATH,
    join(homedir(), ".local", "bin", "agent"),
  ]) {
    if (path && existsSync(path)) return path;
  }
  try {
    const { stdout } = await execFileAsync("which", ["agent"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const found = stdout.trim().split("\n")[0];
    return found && existsSync(found) ? found : null;
  } catch {
    return null;
  }
}
