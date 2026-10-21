import {
  type AgentMapping,
  type PiSessionContent,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  MCODE_RUNTIME_DB_PATH,
  MCODE_SESSIONS_DIR,
  type McodeSessionRecord,
  getMcodeTranscriptStats,
  listMcodeSessionRecords,
  readMcodeTranscript,
} from "./mcode-store.js";
import { convertPiSession, derivePiSession } from "./normalization.js";
import { sanitizePublicUserPrompt } from "./public-user-prompt.js";
import type { AgentSession as AgentSessionResult } from "./reader.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";

const CATALOG_CACHE_TTL_MS = 3_000;

export interface McodeSessionReaderOptions {
  dbPath?: string;
  sessionsDir?: string;
  projectPath?: string;
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
}

function truncateTitle(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

/**
 * mcode's title generator occasionally leaks closing tag fragments such as
 * `</</title>` into the stored title.
 */
export function cleanMcodeTitle(title: string | null): string {
  if (!title) return "";
  return title
    .replace(/(?:<\/?)+title>/gi, "")
    .replace(/<\/?$/, "")
    .trim();
}

/**
 * Read MiniMax Code sessions (CLI and desktop App share one catalog).
 *
 * The runtime SQLite catalog provides cwd/title/timestamps; the transcript is
 * the session's Pi-shaped `messages.jsonl`, projected through Pi's converter.
 */
export class McodeSessionReader implements ISessionReader {
  private readonly dbPath: string;
  private readonly sessionsDir: string;
  private readonly projectPath: string | undefined;
  private readonly getContextWindow?: McodeSessionReaderOptions["getContextWindow"];
  private catalog: { records: McodeSessionRecord[]; at: number } | null = null;

  constructor(options: McodeSessionReaderOptions = {}) {
    this.dbPath = options.dbPath ?? MCODE_RUNTIME_DB_PATH;
    this.sessionsDir = options.sessionsDir ?? MCODE_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.getContextWindow = options.getContextWindow;
  }

  invalidateCache(): void {
    this.catalog = null;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const records = await this.scopedRecords();
    const summaries = await Promise.all(
      records.map((record) => this.summaryFor(record, projectId)),
    );
    return summaries
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const record = await this.findRecord(sessionId);
    return record ? this.summaryFor(record, projectId) : null;
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const record = await this.findRecord(sessionId);
    if (!record) return null;
    const deferMedia = options?.deferMedia === true;
    const deferThinking = options?.deferThinking === true;
    const session = await readMcodeTranscript(record, {
      deferMedia,
      deferThinking,
    });
    if (!session) return null;
    const conversion = convertPiSession(session, {
      deferMedia,
      deferThinking,
      getContextWindow: this.getContextWindow,
    });
    const summary = this.buildSummary(
      record,
      projectId,
      session,
      conversion.derived,
    );
    return {
      summary,
      data: { provider: "mcode", session },
      precomputedPiMessages: {
        messages: conversion.messages,
        deferMedia,
        deferThinking,
      },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    if (!record) return null;
    const stats = await getMcodeTranscriptStats(record.messagesPath);
    if (!stats) return null;
    if (stats.mtime === cachedMtime && stats.size === cachedSize) return null;
    const summary = await this.summaryFor(record, projectId);
    return summary ? { summary, ...stats } : null;
  }

  async getAgentMappings(): Promise<AgentMapping[]> {
    return [];
  }

  async getAgentSession(): Promise<AgentSessionResult | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    return (await this.findRecord(sessionId))?.messagesPath ?? null;
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    return record ? getMcodeTranscriptStats(record.messagesPath) : null;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const records = await this.scopedRecords(true);
    const files: SessionFileEntry[] = [];
    for (const record of records) {
      const stats = await getMcodeTranscriptStats(record.messagesPath);
      if (!stats) continue;
      files.push({
        sessionId: record.sessionId,
        filePath: record.messagesPath,
        mtime: stats.mtime,
        size: stats.size,
      });
    }
    return files;
  }

  getIndexScopeKey(): string {
    return `mcode::${this.sessionsDir}::${this.projectPath ?? "*"}::v1`;
  }

  private async summaryFor(
    record: McodeSessionRecord,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const session = await readMcodeTranscript(record, {
      deferMedia: true,
      deferThinking: true,
    });
    if (!session) return null;
    const derived = derivePiSession(session, {
      getContextWindow: this.getContextWindow,
    });
    if (derived.messageCount === 0) return null;
    return this.buildSummary(record, projectId, session, derived);
  }

  private buildSummary(
    record: McodeSessionRecord,
    projectId: UrlProjectId,
    session: PiSessionContent,
    derived: ReturnType<typeof derivePiSession>,
  ): SessionSummary {
    // mcode generates a concise title server-side; fall back to the first
    // genuine user prompt for sessions whose title is not ready yet.
    const promptTitle = sanitizePublicUserPrompt(derived.titleText).trim();
    const fullTitle = cleanMcodeTitle(record.title) || promptTitle || null;
    const lastTimestamp = session.activeEntries.at(-1)?.timestamp;
    const updatedAt = new Date(
      Math.max(
        record.updatedAtMs,
        lastTimestamp ? Date.parse(lastTimestamp) || 0 : 0,
      ),
    ).toISOString();
    return {
      id: record.sessionId,
      projectId,
      title: truncateTitle(fullTitle),
      fullTitle,
      createdAt: new Date(record.createdAtMs).toISOString(),
      updatedAt,
      messageCount: derived.messageCount,
      userQuestions: derived.userQuestions,
      ownership: { owner: "none" },
      provider: "mcode",
      model: derived.model,
      reasoningEffort: derived.reasoningEffort,
      contextUsage: derived.contextUsage,
      cumulativeUsage: derived.cumulativeUsage,
      compactCount: derived.compactEvents?.length ?? 0,
      compactEvents: derived.compactEvents,
      lastTurnStatus: derived.lastTurnStatus,
      lastErrorMessage: derived.lastErrorMessage,
    };
  }

  private async records(force = false): Promise<McodeSessionRecord[]> {
    if (
      !force &&
      this.catalog &&
      Date.now() - this.catalog.at < CATALOG_CACHE_TTL_MS
    ) {
      return this.catalog.records;
    }
    const records = await listMcodeSessionRecords({
      dbPath: this.dbPath,
      sessionsDir: this.sessionsDir,
    });
    this.catalog = { records, at: Date.now() };
    return records;
  }

  private async scopedRecords(force = false): Promise<McodeSessionRecord[]> {
    const records = await this.records(force);
    if (!this.projectPath) return records;
    return records.filter(
      (record) => canonicalizeProjectPath(record.cwd) === this.projectPath,
    );
  }

  private async findRecord(
    sessionId: string,
    force = false,
  ): Promise<McodeSessionRecord | null> {
    const match = (records: McodeSessionRecord[]) =>
      records.find((record) => record.sessionId === sessionId) ?? null;
    const scoped = await this.scopedRecords(force);
    const found = match(scoped);
    if (found || force) return found;
    // A session created through ACP a moment ago may postdate the cached
    // catalog; retry once with a fresh read before reporting a miss.
    return match(await this.scopedRecords(true));
  }
}
