import { basename } from "node:path";
import {
  MCODE_RUNTIME_DB_PATH,
  MCODE_SESSIONS_DIR,
  type McodeSessionRecord,
  listMcodeSessionRecords,
} from "../sessions/mcode-store.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

const SCAN_CACHE_TTL_MS = 5_000;

export interface McodeScannerOptions {
  dbPath?: string;
  sessionsDir?: string;
}

/** Group MiniMax Code catalog rows into Yep projects by workspace cwd. */
export class McodeSessionScanner {
  private readonly dbPath: string;
  private readonly sessionsDir: string;
  private cache: { records: McodeSessionRecord[]; at: number } | null = null;

  constructor(options: McodeScannerOptions = {}) {
    this.dbPath = options.dbPath ?? MCODE_RUNTIME_DB_PATH;
    this.sessionsDir = options.sessionsDir ?? MCODE_SESSIONS_DIR;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  async listProjects(): Promise<Project[]> {
    const records = await this.scan();
    const grouped = new Map<
      string,
      { count: number; lastActivity: string | null }
    >();
    for (const record of records) {
      const path = canonicalizeProjectPath(record.cwd);
      const updatedAt = new Date(record.updatedAtMs).toISOString();
      const current = grouped.get(path);
      if (current) {
        current.count += 1;
        if (!current.lastActivity || updatedAt > current.lastActivity) {
          current.lastActivity = updatedAt;
        }
      } else {
        grouped.set(path, { count: 1, lastActivity: updatedAt });
      }
    }
    return Array.from(grouped, ([path, value]) => ({
      id: encodeProjectId(path),
      path,
      name: basename(path),
      sessionCount: value.count,
      sessionDir: this.sessionsDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: value.lastActivity,
      provider: "mcode" as const,
      hasMcodeSessions: true,
    }));
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<McodeSessionRecord[]> {
    const target = canonicalizeProjectPath(projectPath);
    const records = await this.scan();
    return records.filter(
      (record) => canonicalizeProjectPath(record.cwd) === target,
    );
  }

  private async scan(): Promise<McodeSessionRecord[]> {
    if (this.cache && Date.now() - this.cache.at < SCAN_CACHE_TTL_MS) {
      return this.cache.records;
    }
    const records = await listMcodeSessionRecords({
      dbPath: this.dbPath,
      sessionsDir: this.sessionsDir,
    });
    this.cache = { records, at: Date.now() };
    return records;
  }
}
