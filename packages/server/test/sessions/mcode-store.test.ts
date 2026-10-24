import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { McodeSessionReader } from "../../src/sessions/mcode-reader.js";
import {
  findMcodeSessionRecord,
  listMcodeSessionRecords,
  mcodeSessionIdFromWatchPath,
  parseMcodeMessagesJsonl,
  readMcodeGenuineUserText,
  resolveMcodeHistoryDir,
  summarizeMcodeQuestionnaireResponse,
} from "../../src/sessions/mcode-store.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

function openSqlite() {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as
    | {
        DatabaseSync: new (
          path: string,
        ) => {
          exec(sql: string): void;
          prepare(sql: string): { run(...params: unknown[]): unknown };
          close(): void;
        };
      }
    | undefined;
  if (!sqlite) throw new Error("node:sqlite unavailable");
  return sqlite;
}

const REMINDER = "<system-reminder>\nagent context\n</system-reminder>\n\n";

function historyDirFor(sessionId: string): string {
  return `2026/10/20/12-16-57-980-session_${Buffer.from(sessionId).toString("base64url")}`;
}

interface Row {
  sessionId: string;
  cwd: string;
  title?: string | null;
  kind?: string;
  parent?: string | null;
  isDefault?: 0 | 1;
  archived?: 0 | 1;
  visibility?: string;
  history?: string | null;
}

async function createStore(rows: Row[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "mcode-store-"));
  const sessionsDir = join(dataDir, "v2", "sessions");
  const sqliteDir = join(dataDir, "v2", "sqlite");
  await mkdir(sqliteDir, { recursive: true });
  const dbPath = join(sqliteDir, "runtime-state.sqlite");
  const db = new (openSqlite().DatabaseSync)(dbPath);
  db.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL DEFAULT '{}',
    updated_at_ms INTEGER NOT NULL, columnar_version INTEGER NOT NULL DEFAULT 3,
    status TEXT, archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible',
    session_kind TEXT NOT NULL DEFAULT 'conversation',
    parent_session_id TEXT, workspace_dir TEXT,
    is_default_workspace INTEGER NOT NULL DEFAULT 0, title TEXT,
    created_at_ms INTEGER, history_relative_dir TEXT)`);
  const insert = db.prepare(
    `INSERT INTO local_runtime_sessions (session_id, updated_at_ms, status,
      archived, visibility, session_kind, parent_session_id, workspace_dir,
      is_default_workspace, title, created_at_ms, history_relative_dir)
     VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.sessionId,
      1_792_498_892_323,
      row.archived ?? 0,
      row.visibility ?? "visible",
      row.kind ?? "conversation",
      row.parent ?? null,
      row.cwd,
      row.isDefault ?? 0,
      row.title ?? null,
      1_792_498_617_980,
      row.history === undefined ? historyDirFor(row.sessionId) : row.history,
    );
  }
  db.close();
  return { dataDir, sessionsDir, dbPath };
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  rows: unknown[],
) {
  const dir = join(sessionsDir, historyDirFor(sessionId));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "messages.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

const TRANSCRIPT = [
  {
    message_id: "msg-user-1",
    turn_id: "turn-1",
    message: {
      role: "user",
      content: [{ type: "text", text: `${REMINDER}列出文件` }],
      timestamp: 1_792_498_620_000,
      canonicalTextRange: {
        startOffset: REMINDER.length,
        endOffset: REMINDER.length + 4,
      },
    },
  },
  {
    message_id: "msg-assistant-1",
    turn_id: "turn-1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to list files." },
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolCall",
          id: "call_2",
          name: "glob",
          arguments: { pattern: "**/*.ts" },
        },
      ],
      api: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M3",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
      },
      stopReason: "toolUse",
      timestamp: 1_792_498_621_000,
    },
  },
  {
    message_id: "msg-tool-1",
    turn_id: "turn-1",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "# Readme" }],
      isError: false,
      timestamp: 1_792_498_622_000,
    },
  },
  {
    message_id: "msg-bg",
    turn_id: "turn-2",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "<background-task-finished>done</background-task-finished>",
        },
      ],
      timestamp: 1_792_498_623_000,
    },
  },
  {
    message_id: "msg-assistant-2",
    turn_id: "turn-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Found one README." }],
      provider: "minimax",
      model: "MiniMax-M3",
      stopReason: "stop",
      timestamp: 1_792_498_624_000,
    },
  },
];

describe("MiniMax Code session store", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("lists only resumable root conversations from the runtime catalog", async () => {
    const store = await createStore([
      { sessionId: "mvs_root", cwd: "/work/app", title: "Root" },
      { sessionId: "mvs_task", cwd: "/work/app", kind: "task", parent: "x" },
      { sessionId: "mvs_hidden", cwd: "/work/app", visibility: "hidden" },
      { sessionId: "mvs_archived", cwd: "/work/app", archived: 1 },
      { sessionId: "mvs_default", cwd: "/Users/x/.minimax/s", isDefault: 1 },
      { sessionId: "mvs_nohistory", cwd: "/work/app", history: null },
      { sessionId: "mvs_escape", cwd: "/work/app", history: "../../a/b" },
      { sessionId: "mvs_empty", cwd: "/work/app" },
    ]);
    dirs.push(store.dataDir);
    for (const id of [
      "mvs_root",
      "mvs_task",
      "mvs_hidden",
      "mvs_archived",
      "mvs_default",
    ]) {
      await writeTranscript(store.sessionsDir, id, TRANSCRIPT);
    }
    // session/new creates an empty transcript before the first prompt.
    await writeTranscript(store.sessionsDir, "mvs_empty", []);
    await writeFile(
      join(store.sessionsDir, historyDirFor("mvs_empty"), "messages.jsonl"),
      "",
    );

    const records = await listMcodeSessionRecords(store);
    expect(records.map((record) => record.sessionId)).toEqual(["mvs_root"]);
    expect(records[0]?.messagesPath).toBe(
      join(store.sessionsDir, historyDirFor("mvs_root"), "messages.jsonl"),
    );

    // The single-row lookup applies the same catalog filters.
    expect(await findMcodeSessionRecord("mvs_root", store)).toEqual(records[0]);
    for (const id of [
      "mvs_task",
      "mvs_hidden",
      "mvs_archived",
      "mvs_default",
      "mvs_empty",
      "mvs_missing",
    ]) {
      expect(await findMcodeSessionRecord(id, store)).toBeNull();
    }
  });

  it("refuses history directories that escape the sessions root", () => {
    expect(resolveMcodeHistoryDir("2026/10/20/x", "/root")).toBe(
      "/root/2026/10/20/x",
    );
    expect(resolveMcodeHistoryDir("../10/20/x", "/root")).toBeNull();
    expect(resolveMcodeHistoryDir("/abs/10/20/x", "/root")).toBeNull();
    expect(resolveMcodeHistoryDir("2026/10/x", "/root")).toBeNull();
  });

  it("recovers the genuine user text from mcode prompt envelopes", () => {
    expect(
      readMcodeGenuineUserText({
        content: [{ type: "text", text: `${REMINDER}你好` }],
        canonicalTextRange: {
          startOffset: REMINDER.length,
          endOffset: REMINDER.length + 2,
        },
      }),
    ).toBe("你好");
    expect(
      readMcodeGenuineUserText({
        content: [{ type: "text", text: "envelope" }],
        genuineUserQueryText: "real",
      }),
    ).toBe("real");
    expect(
      readMcodeGenuineUserText({
        content: [{ type: "text", text: `${REMINDER}legacy text` }],
      }),
    ).toBe("legacy text");
  });

  it("adapts messages.jsonl into a linear Pi session with Yep tool names", () => {
    const session = parseMcodeMessagesJsonl(
      `${TRANSCRIPT.map((row) => JSON.stringify(row)).join("\n")}\n{"torn`,
      { sessionId: "mvs_root", cwd: "/work/app", createdAtMs: 1 },
    );
    // The background-task notification has no genuine user text.
    expect(session.entries.map((entry) => entry.id)).toEqual([
      "msg-user-1",
      "msg-assistant-1",
      "msg-tool-1",
      "msg-assistant-2",
    ]);
    expect(session.entries[1]?.parentId).toBe("msg-user-1");
    const assistant = session.entries[1] as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(assistant.message.content[1]).toMatchObject({
      name: "Read",
      arguments: { path: "README.md", file_path: "README.md" },
    });
    expect(assistant.message.content[2]).toMatchObject({ name: "Glob" });
  });

  it("reads summaries and normalized transcripts through the reader", async () => {
    const store = await createStore([
      { sessionId: "mvs_root", cwd: "/work/app", title: "列出项目文件" },
      { sessionId: "mvs_other", cwd: "/work/other" },
    ]);
    dirs.push(store.dataDir);
    await writeTranscript(store.sessionsDir, "mvs_root", TRANSCRIPT);
    await writeTranscript(store.sessionsDir, "mvs_other", TRANSCRIPT);

    const reader = new McodeSessionReader({
      dbPath: store.dbPath,
      sessionsDir: store.sessionsDir,
      projectPath: "/work/app",
    });
    const projectId = "project" as UrlProjectId;
    const sessions = await reader.listSessions(projectId);
    expect(sessions.map((session) => session.id)).toEqual(["mvs_root"]);
    expect(sessions[0]).toMatchObject({
      provider: "mcode",
      title: "列出项目文件",
    });

    const loaded = await reader.getSession("mvs_root", projectId);
    expect(loaded?.data.provider).toBe("mcode");
    if (!loaded) throw new Error("session missing");
    const normalized = normalizeSession(loaded);
    const user = normalized.messages[0];
    expect(user?.message?.content).toEqual([
      { type: "text", text: "列出文件" },
    ]);
    const toolUse = normalized.messages
      .flatMap((message) =>
        Array.isArray(message.message?.content) ? message.message.content : [],
      )
      .find(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "tool_use",
      );
    expect(toolUse).toMatchObject({ name: "Read", id: "call_1" });

    expect(await reader.getSession("mvs_other", projectId)).toBeNull();
  });

  it("shows questionnaire answers as their readable Q/A summary", () => {
    const text = `${REMINDER}<questionnaire-response>\n  <answers/>\n</questionnaire-response>\n\nQ: Which planet?  \nA: Mars`;
    expect(summarizeMcodeQuestionnaireResponse(text)).toBe(
      "Q: Which planet?\nA: Mars",
    );
    expect(summarizeMcodeQuestionnaireResponse("plain")).toBeNull();
    const session = parseMcodeMessagesJsonl(
      JSON.stringify({
        message_id: "msg-q",
        message: {
          role: "user",
          content: [{ type: "text", text }],
          canonicalTextRange: {
            startOffset: text.length,
            endOffset: text.length,
          },
          timestamp: 2,
        },
      }),
      { sessionId: "mvs_q", cwd: "/w", createdAtMs: 1 },
    );
    expect(
      (session.entries[0] as { message: { content: unknown } }).message.content,
    ).toEqual([{ type: "text", text: "Q: Which planet?\nA: Mars" }]);

    // Rows without a recorded range must not leak the XML envelope either.
    expect(
      readMcodeGenuineUserText({ content: [{ type: "text", text }] }),
    ).toBe("Q: Which planet?\nA: Mars");
  });

  it("decodes session ids from watched history paths", () => {
    const dir = historyDirFor("mvs_abc123");
    expect(mcodeSessionIdFromWatchPath(`/root/${dir}`)).toBe("mvs_abc123");
    expect(mcodeSessionIdFromWatchPath(`/root/${dir}/messages.jsonl`)).toBe(
      "mvs_abc123",
    );
    expect(mcodeSessionIdFromWatchPath("/root/2026/10/20")).toBeNull();
  });
});
