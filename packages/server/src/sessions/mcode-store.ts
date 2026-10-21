/**
 * MiniMax Code (`mcode`) on-disk session store.
 *
 * MiniMax Code CLI and the MiniMax Code desktop App share one data directory
 * (`~/.minimax` by default). The session catalog lives in the local runtime
 * SQLite database and each session's canonical transcript is an append-only
 * `messages.jsonl` whose rows wrap Pi-shaped AgentMessages:
 *
 *   {"message_id": "...", "turn_id": "...", "message": PiAgentMessage}
 *
 * Upstream references (read-only):
 * - references/minimax/app/mavis/local-runtime-v2/src/service/session-system/
 *   messages/history/session-history-paths.ts (layout, manifest)
 * - references/minimax/app/mavis/local-runtime-v2/src/service/memory-system/
 *   adapters/capture-history.ts (genuine user text / canonicalTextRange)
 *
 * Everything here is strictly read-only: Yep never writes MiniMax's database
 * or transcripts. Mutations always go through `mcode acp`.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  PiAgentMessage,
  PiContentBlock,
  PiImageContent,
  PiMessageEntry,
  PiSessionContent,
  PiSessionEntry,
  PiTextContent,
} from "@yep-anywhere/shared";
import { withSqliteDatabase } from "../sqlite/query.js";
import {
  canonicalizeMcodeToolName,
  normalizeMcodeToolArguments,
} from "./mcode-tools.js";

const PROFILE_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/**
 * Resolve MiniMax Code's data directory with the same precedence as mcode:
 * `MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR` → `~/.minimax[-<MINIMAX_PROFILE>]`.
 * `MCODE_DATA_DIR` is a Yep-only override used by tests and diagnostics.
 */
export function resolveMcodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit =
    env.MCODE_DATA_DIR?.trim() ||
    env.MINIMAX_DATA_DIR?.trim() ||
    env.MAVIS_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const profile = env.MINIMAX_PROFILE?.trim();
  if (profile && profile !== "default" && PROFILE_NAME_RE.test(profile)) {
    return join(homedir(), `.minimax-${profile}`);
  }
  return join(homedir(), ".minimax");
}

export const MCODE_DATA_DIR = resolveMcodeDataDir();
/** Root of dated session history directories (watched for changes). */
export const MCODE_SESSIONS_DIR = join(MCODE_DATA_DIR, "v2", "sessions");
/** Local runtime catalog shared by mcode CLI and the desktop App. */
export const MCODE_RUNTIME_DB_PATH = join(
  MCODE_DATA_DIR,
  "v2",
  "sqlite",
  "runtime-state.sqlite",
);

/**
 * Whether sessions living in the desktop App's per-session default workspace
 * (`~/.minimax/sessions/<id>/workspace`) are listed. Those are project-less
 * chats; listing them would create one Yep project per conversation.
 */
function includeDefaultWorkspaceSessions(): boolean {
  const raw = process.env.MCODE_INCLUDE_DEFAULT_WORKSPACE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export interface McodeSessionRecord {
  sessionId: string;
  cwd: string;
  title: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  status: string | null;
  /** Absolute session history directory, validated to stay inside the root. */
  historyDir: string;
  messagesPath: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/**
 * Resolve a `history_relative_dir` (`YYYY/MM/DD/<time>-session_<b64>`) the
 * same way mcode validates it, refusing anything that escapes the root.
 */
export function resolveMcodeHistoryDir(
  relativeDir: string,
  sessionsDir: string = MCODE_SESSIONS_DIR,
): string | null {
  if (!relativeDir || relativeDir !== relativeDir.trim()) return null;
  if (relativeDir.includes("\\") || isAbsolute(relativeDir)) return null;
  const segments = relativeDir.split("/");
  if (
    segments.length !== 4 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const dir = join(sessionsDir, ...segments);
  const rel = relative(sessionsDir, dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return dir;
}

export interface McodeStoreOptions {
  dbPath?: string;
  sessionsDir?: string;
}

/**
 * List user-facing root conversations from the runtime catalog.
 *
 * Subagent (`task`), cron, peek and channel sessions, hidden/archived rows and
 * rows without a materialized history directory are excluded — they are not
 * resumable top-level conversations.
 */
export async function listMcodeSessionRecords(
  options: McodeStoreOptions = {},
): Promise<McodeSessionRecord[]> {
  const dbPath = options.dbPath ?? MCODE_RUNTIME_DB_PATH;
  const sessionsDir = options.sessionsDir ?? MCODE_SESSIONS_DIR;
  const includeDefault = includeDefaultWorkspaceSessions();
  const rows = await withSqliteDatabase<Record<string, unknown>[]>(
    dbPath,
    [],
    (db) =>
      db
        .prepare(
          `SELECT session_id, workspace_dir, title, created_at_ms, updated_at_ms,
                  status, is_default_workspace, history_relative_dir
             FROM local_runtime_sessions
            WHERE columnar_version = 3
              AND archived = 0
              AND visibility <> 'hidden'
              AND session_kind = 'conversation'
              AND parent_session_id IS NULL
              AND history_relative_dir IS NOT NULL
              AND workspace_dir IS NOT NULL
            ORDER BY updated_at_ms DESC`,
        )
        .all(),
  );

  const records: McodeSessionRecord[] = [];
  for (const row of rows) {
    const sessionId = asString(row.session_id);
    const cwd = asString(row.workspace_dir);
    const relativeDir = asString(row.history_relative_dir);
    if (!sessionId || !cwd || !relativeDir) continue;
    if (!includeDefault && asNumber(row.is_default_workspace) === 1) continue;
    const historyDir = resolveMcodeHistoryDir(relativeDir, sessionsDir);
    if (!historyDir) continue;
    const messagesPath = join(historyDir, "messages.jsonl");
    // session/new materializes an empty transcript immediately; a session the
    // user never prompted is not a conversation worth listing.
    const stats = await getMcodeTranscriptStats(messagesPath);
    if (!stats || stats.size === 0) continue;
    const createdAtMs = asNumber(row.created_at_ms) ?? 0;
    records.push({
      sessionId,
      cwd,
      title: asString(row.title),
      createdAtMs,
      updatedAtMs: asNumber(row.updated_at_ms) ?? createdAtMs,
      status: asString(row.status),
      historyDir,
      messagesPath,
    });
  }
  return records;
}

export async function getMcodeTranscriptStats(
  messagesPath: string,
): Promise<{ mtime: number; size: number } | null> {
  try {
    const info = await stat(messagesPath);
    return { mtime: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text blocks of a user message, concatenated the way mcode measures ranges. */
function readSingleText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [],
  );
  return texts.length === 1 ? texts[0] : undefined;
}

function joinedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

function stripGeneratedBlocks(content: string): string {
  return content
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu, "")
    .replace(
      /<background-task-finished\b[^>]*>[\s\S]*?<\/background-task-finished>/giu,
      "",
    )
    .replace(/<(?:system-reminder|background-task-finished)\b[^>]*\/>/giu, "")
    .trim();
}

/**
 * mcode records a questionnaire answer as a host-injected user turn: a
 * `<questionnaire-response>` XML block followed by a readable `Q: … A: …`
 * summary. Return that summary (or null when the text is not a response).
 */
export function summarizeMcodeQuestionnaireResponse(
  text: string,
): string | null {
  const end = text.lastIndexOf("</questionnaire-response>");
  if (end < 0) return null;
  const summary = text
    .slice(end + "</questionnaire-response>".length)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return summary || null;
}

/**
 * Recover the text the user actually typed. mcode prepends large
 * `<system-reminder>` envelopes to user turns and records the genuine span via
 * `genuineUserQueryText` or `canonicalTextRange` (newer rows). Older rows fall
 * back to stripping the known generated blocks.
 */
export function readMcodeGenuineUserText(
  message: Record<string, unknown>,
): string {
  if (typeof message.genuineUserQueryText === "string") {
    return message.genuineUserQueryText;
  }
  const range = message.canonicalTextRange;
  if (isRecord(range)) {
    const content = readSingleText(message.content);
    const { startOffset, endOffset } = range;
    if (
      content !== undefined &&
      typeof startOffset === "number" &&
      typeof endOffset === "number" &&
      Number.isSafeInteger(startOffset) &&
      Number.isSafeInteger(endOffset) &&
      startOffset >= 0 &&
      endOffset >= startOffset &&
      endOffset <= content.length
    ) {
      return content.slice(startOffset, endOffset);
    }
  }
  return stripGeneratedBlocks(joinedText(message.content));
}

export interface McodeTranscriptOptions {
  deferMedia?: boolean;
  deferThinking?: boolean;
}

const THINKING_PREVIEW_MAX = 240;

function adaptUserMessage(
  message: Record<string, unknown>,
  options: McodeTranscriptOptions,
): PiAgentMessage | null {
  const text =
    readMcodeGenuineUserText(message).trim() ||
    summarizeMcodeQuestionnaireResponse(joinedText(message.content)) ||
    "";
  const images: PiImageContent[] = Array.isArray(message.content)
    ? message.content.flatMap((block): PiImageContent[] => {
        if (!isRecord(block) || block.type !== "image") return [];
        const mimeType =
          typeof block.mimeType === "string" ? block.mimeType : "image/png";
        const data = typeof block.data === "string" ? block.data : "";
        return [
          options.deferMedia
            ? { type: "image", data: "", mimeType, deferred: true }
            : { type: "image", data, mimeType },
        ];
      })
    : [];
  // Host-injected turns (background task notifications, cron envelopes) have
  // no genuine user text; they are runtime plumbing, not conversation.
  if (!text && images.length === 0) return null;
  const content: Array<PiTextContent | PiImageContent> = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images,
  ];
  return {
    role: "user",
    content,
    ...(typeof message.timestamp === "number"
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function adaptAssistantMessage(
  message: Record<string, unknown>,
  options: McodeTranscriptOptions,
): PiAgentMessage {
  const content: PiContentBlock[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === "toolCall" && typeof block.name === "string") {
      content.push({
        type: "toolCall",
        id: typeof block.id === "string" ? block.id : "",
        name: canonicalizeMcodeToolName(block.name),
        arguments: normalizeMcodeToolArguments(block.name, block.arguments),
      });
      continue;
    }
    if (
      block.type === "thinking" &&
      options.deferThinking &&
      typeof block.thinking === "string" &&
      block.thinking.length > THINKING_PREVIEW_MAX
    ) {
      content.push({
        type: "thinking",
        thinking: block.thinking.slice(0, THINKING_PREVIEW_MAX),
        deferred: true,
        thinkingLength: block.thinking.length,
      });
      continue;
    }
    if (
      block.type === "image" &&
      options.deferMedia &&
      typeof block.mimeType === "string"
    ) {
      content.push({
        type: "image",
        data: "",
        mimeType: block.mimeType,
        deferred: true,
      });
      continue;
    }
    content.push(block as unknown as PiContentBlock);
  }
  return { ...(message as object), content } as unknown as PiAgentMessage;
}

function adaptToolResultMessage(
  message: Record<string, unknown>,
  options: McodeTranscriptOptions,
): PiAgentMessage {
  if (!options.deferMedia || !Array.isArray(message.content)) {
    return message as unknown as PiAgentMessage;
  }
  return {
    ...(message as object),
    content: message.content.map((block) =>
      isRecord(block) && block.type === "image"
        ? { ...block, data: "", deferred: true }
        : block,
    ),
  } as unknown as PiAgentMessage;
}

/**
 * Parse `messages.jsonl` into a linear Pi session. Each row becomes a Pi
 * `message` entry chained to the previous one, so Pi's active-branch walk
 * returns the rows in file order.
 */
export function parseMcodeMessagesJsonl(
  raw: string,
  header: { sessionId: string; cwd: string; createdAtMs: number },
  options: McodeTranscriptOptions = {},
): PiSessionContent {
  const entries: PiSessionEntry[] = [];
  let parentId: string | null = null;
  let lineIndex = 0;
  for (const line of raw.split("\n")) {
    lineIndex += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      // A torn final line is expected while mcode is appending.
      continue;
    }
    if (!isRecord(row) || !isRecord(row.message)) continue;
    const message = row.message;
    const id =
      typeof row.message_id === "string" && row.message_id
        ? row.message_id
        : `mcode-line-${lineIndex}`;
    let adapted: PiAgentMessage | null;
    switch (message.role) {
      case "user":
        adapted = adaptUserMessage(message, options);
        break;
      case "assistant":
        adapted = adaptAssistantMessage(message, options);
        break;
      case "toolResult":
        adapted = adaptToolResultMessage(message, options);
        break;
      default:
        adapted = message as unknown as PiAgentMessage;
    }
    if (!adapted) continue;
    const timestampMs =
      typeof message.timestamp === "number" ? message.timestamp : null;
    const entry: PiMessageEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date(
        timestampMs ?? header.createdAtMs ?? Date.now(),
      ).toISOString(),
      message: adapted,
    };
    entries.push(entry);
    parentId = id;
  }
  return {
    header: {
      type: "session",
      id: header.sessionId,
      timestamp: new Date(header.createdAtMs || Date.now()).toISOString(),
      cwd: header.cwd,
    },
    entries,
    activeEntries: entries,
  };
}

export async function readMcodeTranscript(
  record: Pick<
    McodeSessionRecord,
    "sessionId" | "cwd" | "createdAtMs" | "messagesPath"
  >,
  options: McodeTranscriptOptions = {},
): Promise<PiSessionContent | null> {
  let raw: string;
  try {
    raw = await readFile(record.messagesPath, "utf8");
  } catch {
    return null;
  }
  return parseMcodeMessagesJsonl(raw, record, options);
}

/**
 * Session id for a watched file under `v2/sessions`. The directory name ends
 * with `session_<base64url(sessionId)>`.
 */
export function mcodeSessionIdFromWatchPath(filePath: string): string | null {
  const match = /session_([A-Za-z0-9_-]+)(?:[\\/][^\\/]*)?$/.exec(filePath);
  if (!match?.[1]) return null;
  try {
    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    return /^mvs_[A-Za-z0-9]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
