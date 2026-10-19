import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Launching and updating must resolve the same DSH installation. */
export async function findDshCliPath(): Promise<string | null> {
  const configured = process.env.YEP_DSH_PATH;
  const candidates = configured
    ? [configured]
    : [
        join(dirname(process.execPath), "dsh"),
        join(homedir(), ".local", "bin", "dsh"),
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, "dsh")),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next installation location. */
    }
  }
  return null;
}
