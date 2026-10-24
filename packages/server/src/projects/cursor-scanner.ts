import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { CURSOR_ACP_SESSIONS_DIR } from "../sessions/cursor-reader.js";
import {
  getCursorSessionFileStats,
  parseCursorMetaJson,
} from "../sessions/cursor-store.js";
import type { Project } from "../supervisor/types.js";
import { encodeProjectId } from "./paths.js";

const SCAN_CACHE_TTL_MS = 5_000;

export interface CursorScannerOptions {
  sessionsDir?: string;
}

export interface CursorScanRecord {
  sessionId: string;
  cwd: string;
  updatedAt: string;
}

export class CursorSessionScanner {
  private readonly sessionsDir: string;
  private cache: { records: CursorScanRecord[]; at: number } | null = null;

  constructor(options: CursorScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? CURSOR_ACP_SESSIONS_DIR;
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
      const current = grouped.get(record.cwd);
      if (current) {
        current.count += 1;
        if (!current.lastActivity || record.updatedAt > current.lastActivity) {
          current.lastActivity = record.updatedAt;
        }
      } else {
        grouped.set(record.cwd, {
          count: 1,
          lastActivity: record.updatedAt,
        });
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
      provider: "cursor" as const,
      hasCursorSessions: true,
    }));
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<CursorScanRecord[]> {
    const records = await this.scan();
    return records.filter((record) => record.cwd === projectPath);
  }

  private async scan(): Promise<CursorScanRecord[]> {
    if (this.cache && Date.now() - this.cache.at < SCAN_CACHE_TTL_MS) {
      return this.cache.records;
    }
    let names: string[] = [];
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      names = [];
    }
    const records: CursorScanRecord[] = [];
    for (const sessionId of names) {
      const dir = join(this.sessionsDir, sessionId);
      try {
        const [metaRaw, info] = await Promise.all([
          readFile(join(dir, "meta.json"), "utf8"),
          getCursorSessionFileStats(dir),
        ]);
        const meta = parseCursorMetaJson(metaRaw);
        if (!meta || !info) continue;
        records.push({
          sessionId,
          cwd: meta.cwd,
          updatedAt: new Date(info.mtime).toISOString(),
        });
      } catch {
        // Sessions without store.db disappear from ACP session/list too.
      }
    }
    this.cache = { records, at: Date.now() };
    return records;
  }
}
