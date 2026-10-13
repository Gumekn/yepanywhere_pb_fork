import { randomBytes } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorSessionReader } from "../../src/sessions/cursor-reader.js";
import { readCursorSessionDir } from "../../src/sessions/cursor-store.js";
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

describe("cursor ACP session store", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("restores native tool calls/results and notices changes committed only to WAL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-tools-"));
    dirs.push(dir);
    const sessionId = dir.split("/").at(-1) as string;
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({ cwd: "/tmp/project" }),
    );
    const db = new (openSqlite().DatabaseSync)(join(dir, "store.db"));
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    const insert = db.prepare("INSERT INTO blobs (id,data) VALUES (?,?)");
    const writeBlob = (value: unknown) => {
      const id = randomBytes(32);
      insert.run(id.toString("hex"), Buffer.from(JSON.stringify(value)));
      return id;
    };
    const ids = [
      writeBlob({ role: "user", content: "<user_query>Run test</user_query>" }),
    ];
    const commitRoot = () => {
      const id = randomBytes(32);
      insert.run(
        id.toString("hex"),
        Buffer.concat(ids.flatMap((child) => [Buffer.from([0x0a, 32]), child])),
      );
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('0',?)").run(
        Buffer.from(
          JSON.stringify({
            latestRootBlobId: id.toString("hex"),
            createdAt: 1700000000000,
          }),
        ).toString("hex"),
      );
    };
    try {
      commitRoot();
      const reader = new CursorSessionReader({
        sessionsDir: join(dir, ".."),
        projectPath: "/tmp/project",
      });
      const before = await reader.getSessionFileStats(sessionId);
      if (!before) throw new Error("Expected initial session stats");
      const mainBefore = await stat(join(dir, "store.db"));
      ids.push(
        writeBlob({
          role: "assistant",
          content: [
            { type: "text", text: "Running" },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "Shell",
              args: { command: "exit 2" },
            },
          ],
        }),
      );
      ids.push(
        writeBlob({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "Shell",
              result: "Exit code: 2",
            },
          ],
          providerOptions: {
            cursor: {
              highLevelToolCallResult: {
                isError: false,
                output: { failure: { exitCode: 2 } },
              },
            },
          },
        }),
      );
      commitRoot();
      const mainAfter = await stat(join(dir, "store.db"));
      expect(mainAfter.mtimeMs).toBe(mainBefore.mtimeMs);
      expect(mainAfter.size).toBe(mainBefore.size);
      expect(
        await reader.getSessionSummaryIfChanged(
          sessionId,
          "project",
          before.mtime,
          before.size,
        ),
      ).toMatchObject({
        summary: { messageCount: 3, userQuestions: [{ text: "Run test" }] },
      });
      const loaded = await reader.getSession(sessionId, "project");
      if (!loaded) throw new Error("Expected persisted Cursor history");
      const normalized = normalizeSession(loaded);
      expect(normalized.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "assistant",
            cursorTurnIndex: 1,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Running" },
                {
                  type: "tool_use",
                  id: "call-1",
                  name: "Bash",
                  input: { command: "exit 2" },
                },
              ],
            },
          }),
          expect.objectContaining({
            type: "user",
            cursorTurnIndex: 1,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-1",
                  content: "Exit code: 2",
                  is_error: true,
                },
              ],
            },
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("reads user and assistant text from the blob tree and skips preamble", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-acp-"));
    dirs.push(dir);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionDir = join(dir, sessionId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionDir);
    await writeFile(
      join(sessionDir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        cwd: "/tmp/cursor-project",
        title: "Pong",
      }),
    );

    const userId = randomBytes(32);
    const infoId = randomBytes(32);
    const assistantId = randomBytes(32);
    const rootId = randomBytes(32);
    const root = Buffer.concat([
      Buffer.from([0x0a, 32]),
      infoId,
      Buffer.from([0x0a, 32]),
      userId,
      Buffer.from([0x0a, 32]),
      assistantId,
    ]);
    const sqlite = openSqlite();
    const db = new sqlite.DatabaseSync(join(sessionDir, "store.db"));
    db.exec(
      "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    insert.run(
      infoId.toString("hex"),
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: "<user_info>\nOS Version: test\n</user_info>",
        }),
      ),
    );
    insert.run(
      userId.toString("hex"),
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: [
            {
              type: "text",
              text: "<timestamp>now</timestamp>\n<user_query>\nReply pong\n</user_query>",
            },
          ],
        }),
      ),
    );
    insert.run(
      assistantId.toString("hex"),
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "reasoning", text: "Say pong." },
            { type: "text", text: "pong" },
          ],
        }),
      ),
    );
    insert.run(rootId.toString("hex"), root);
    const meta = Buffer.from(
      JSON.stringify({
        latestRootBlobId: rootId.toString("hex"),
        name: "Pong",
        createdAt: 1_700_000_000_000,
      }),
    ).toString("hex");
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(meta);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    const session = await readCursorSessionDir(sessionDir);
    expect(session).toMatchObject({
      sessionId,
      cwd: "/tmp/cursor-project",
      title: "Pong",
    });
    expect(session?.messages).toEqual([
      {
        id: `cursor-${userId.toString("hex").slice(0, 12)}`,
        role: "user",
        text: "Reply pong",
      },
      {
        id: `cursor-${assistantId.toString("hex").slice(0, 12)}`,
        role: "assistant",
        text: "pong",
        reasoning: "Say pong.",
      },
    ]);
  });
});
