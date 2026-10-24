import { randomUUID } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexSessionReader,
  codexSummaryScanReadCount,
  resetCodexSummaryScanCache,
  setCodexSummaryScanAfterReadHookForTests,
} from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

const projectId = "streaming-project" as UrlProjectId;

function meta(sessionId: string): Record<string, unknown> {
  return {
    type: "session_meta",
    timestamp: "2026-08-18T00:00:00.000Z",
    payload: {
      id: sessionId,
      cwd: "/tmp/streaming-project",
      timestamp: "2026-08-18T00:00:00.000Z",
      model_provider: "openai",
    },
  };
}

function message(
  role: "user" | "assistant",
  text: string,
  second: number,
): Record<string, unknown> {
  return {
    type: "response_item",
    timestamp: new Date(Date.UTC(2026, 7, 18, 0, 0, second)).toISOString(),
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "user" ? "input_text" : "output_text",
          text,
        },
      ],
    },
  };
}

describe("Codex streaming reader windows", () => {
  let sessionsDir: string;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = randomUUID();
    sessionsDir = join(tmpdir(), `codex-streaming-reader-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
    const entries = [meta(sessionId)];
    for (let turn = 0; turn < 12; turn += 1) {
      entries.push(
        message("user", `prompt ${turn}`, turn * 2 + 1),
        message("assistant", `reply ${turn}`, turn * 2 + 2),
      );
    }
    await writeFile(
      join(sessionsDir, `rollout-${sessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    setCodexSummaryScanAfterReadHookForTests(undefined);
    resetCodexSummaryScanCache();
    invalidateCodexSessionManifest(sessionsDir);
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("applies the message cap before normalization and preserves total count", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    expect(loaded?.paginationApplied).toBe(true);

    const session = loaded ? normalizeSession(loaded) : null;
    expect(session?.messages.map((item) => item.message?.content)).toEqual([
      [{ type: "text", text: "reply 9" }],
      [{ type: "text", text: "prompt 10" }],
      [{ type: "text", text: "reply 10" }],
      [{ type: "text", text: "prompt 11" }],
      [{ type: "text", text: "reply 11" }],
    ]);
    expect(loaded?.pagination).toMatchObject({
      totalMessageCount: 24,
      returnedMessageCount: 5,
      hasOlderMessages: true,
      hasNewerMessages: false,
    });
    expect(loaded?.pagination?.rolloutRevision).toBeTruthy();
  });

  it("reports the latest model in summaries and bounded session reads", async () => {
    const entries = [
      meta(sessionId),
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      message("user", "first", 1),
      message("assistant", "first reply", 2),
      {
        type: "turn_context",
        payload: { model: "gpt-6-astra", effort: "high" },
      },
      message("user", "continue", 3),
      message("assistant", "second reply", 4),
    ];
    await writeFile(
      join(sessionsDir, `rollout-${sessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const reader = new CodexSessionReader({ sessionsDir });
    expect(await reader.getSessionSummary(sessionId, projectId)).toMatchObject({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(
      await reader.getSession(sessionId, projectId, undefined, {
        maxMessages: 1,
      }),
    ).toMatchObject({ summary: { model: "gpt-6-astra" } });

    // A rolled-back model switch must not become the resume model. This also
    // exercises the full branch-aware summary path instead of the stream scan.
    entries.push(
      message("user", "discard this turn", 5),
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      message("assistant", "discard this reply", 6),
      {
        type: "event_msg",
        payload: { type: "thread_rolled_back", num_turns: 1 },
      },
    );
    await writeFile(
      join(sessionsDir, `rollout-${sessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    expect(await reader.getSessionSummary(sessionId, projectId)).toMatchObject({
      model: "gpt-6-astra",
    });
  });

  it("rejects a cursor from a replaced rollout revision", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    const rolloutPath = join(sessionsDir, `rollout-${sessionId}.jsonl`);
    await writeFile(
      rolloutPath,
      `${JSON.stringify(message("assistant", "new tail", 99))}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await expect(
      reader.getSession(sessionId, projectId, undefined, {
        maxMessages: 5,
        beforeMessageId: first?.pagination?.truncatedBeforeMessageId,
        rolloutRevision: first?.pagination?.rolloutRevision,
      }),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");
  });

  it("uses byte-anchored cursors for older and centered windows", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    const firstMessages = first ? normalizeSession(first).messages : [];
    const before = first?.pagination?.truncatedBeforeMessageId;
    expect(before).toBeTruthy();

    const older = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
      beforeMessageId: before,
      rolloutRevision: first?.pagination?.rolloutRevision,
    });
    const olderMessages = older ? normalizeSession(older).messages : [];
    expect(olderMessages).toHaveLength(5);
    expect(olderMessages[0]?.message?.content).toEqual([
      { type: "text", text: "prompt 7" },
    ]);
    expect(older?.pagination).toMatchObject({
      hasOlderMessages: true,
      hasNewerMessages: true,
      totalMessageCount: 24,
    });

    const target = firstMessages[2]?.uuid;
    expect(target).toBeTruthy();
    const centered = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
      aroundMessageId: target,
      rolloutRevision: first?.pagination?.rolloutRevision,
    });
    const centeredMessages = centered
      ? normalizeSession(centered).messages
      : [];
    expect(centeredMessages).toHaveLength(5);
    expect(centeredMessages.map((item) => item.uuid)).toContain(target);
    expect(centered?.pagination?.targetMessageFound).toBe(true);
  });

  it("keeps the first messages after an after-window cursor instead of the tail", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    const revision = first?.pagination?.rolloutRevision;
    const before = first?.pagination?.truncatedBeforeMessageId;
    expect(before).toBeTruthy();

    const older = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
      beforeMessageId: before,
      rolloutRevision: revision,
    });
    expect(older?.pagination?.hasNewerMessages).toBe(true);
    const afterCursor = older?.pagination?.truncatedAfterMessageId;
    expect(afterCursor).toBeTruthy();

    const next = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 3,
      afterWindowMessageId: afterCursor,
      rolloutRevision: revision,
    });
    const nextMessages = next ? normalizeSession(next).messages : [];
    expect(nextMessages.map((item) => item.message?.content)).toEqual([
      [{ type: "text", text: "reply 9" }],
      [{ type: "text", text: "prompt 10" }],
      [{ type: "text", text: "reply 10" }],
    ]);
    expect(next?.pagination).toMatchObject({
      hasOlderMessages: true,
      hasNewerMessages: true,
      totalMessageCount: 24,
      returnedMessageCount: 3,
    });
  });

  it("loads histories containing an inline image tool result larger than 8 MiB", async () => {
    const rolloutPath = join(sessionsDir, `rollout-${sessionId}.jsonl`);
    const entries = [
      meta(sessionId),
      message("user", "inspect the image", 1),
      {
        type: "response_item",
        timestamp: "2026-08-18T00:00:02.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-large-image",
          output: [
            {
              type: "input_image",
              image_url: `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`,
            },
          ],
        },
      },
      message("assistant", "image inspected", 3),
    ];
    await writeFile(
      rolloutPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const reader = new CodexSessionReader({ sessionsDir });
    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      inspectorProjection: true,
      maxMessages: 1,
    });

    expect(
      loaded ? normalizeSession(loaded).messages[0]?.message?.content : null,
    ).toEqual([{ type: "text", text: "image inspected" }]);

  it("reuses a summary scan while the rollout revision is unchanged", async () => {
    resetCodexSummaryScanCache();
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSessionSummary(sessionId, projectId);
    expect(codexSummaryScanReadCount()).toBe(1);
    const second = await reader.getSessionSummary(sessionId, projectId);
    expect(codexSummaryScanReadCount()).toBe(1);
    expect(second).toEqual(first);

    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    expect(codexSummaryScanReadCount()).toBe(1);
    expect(loaded?.summary.messageCount).toBe(first?.messageCount);
    const again = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    expect(codexSummaryScanReadCount()).toBe(1);
    expect(again?.pagination?.totalMessageCount).toBe(24);

    const [parallelA, parallelB] = await Promise.all([
      reader.getSessionSummary(sessionId, projectId),
      reader.getSessionSummary(sessionId, projectId),
    ]);
    expect(codexSummaryScanReadCount()).toBe(1);
    expect(parallelB).toEqual(parallelA);
  });

  it("does not cache a summary when the rollout changes during the scan", async () => {
    resetCodexSummaryScanCache();
    const reader = new CodexSessionReader({ sessionsDir });
    const rolloutPath = join(sessionsDir, `rollout-${sessionId}.jsonl`);
    let bumpMs = Date.now() + 60_000;
    setCodexSummaryScanAfterReadHookForTests(async () => {
      bumpMs += 1000;
      const seconds = bumpMs / 1000;
      await utimes(rolloutPath, seconds, seconds);
    });

    await expect(
      reader.getSession(sessionId, projectId, undefined, { maxMessages: 5 }),
    ).rejects.toThrow("ROLLOUT_CHANGED_DURING_SCAN");
    expect(codexSummaryScanReadCount()).toBe(2);
    setCodexSummaryScanAfterReadHookForTests(undefined);

    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    expect(codexSummaryScanReadCount()).toBe(3);
    expect(loaded?.pagination?.totalMessageCount).toBe(24);
  });

  it("rescans a summary after the rollout grows or is rolled back", async () => {
    resetCodexSummaryScanCache();
    const reader = new CodexSessionReader({ sessionsDir });
    const before = await reader.getSessionSummary(sessionId, projectId);
    expect(before?.messageCount).toBe(24);
    expect(codexSummaryScanReadCount()).toBe(1);

    const rolloutPath = join(sessionsDir, `rollout-${sessionId}.jsonl`);
    await writeFile(
      rolloutPath,
      `${JSON.stringify(message("assistant", "new tail", 99))}\n`,
      { encoding: "utf8", flag: "a" },
    );
    const after = await reader.getSessionSummary(sessionId, projectId);
    expect(codexSummaryScanReadCount()).toBe(2);
    expect(after?.messageCount).toBe(25);

    const rolledBack = [
      meta(sessionId),
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      message("user", "keep", 1),
      message("assistant", "kept", 2),
      message("user", "discard", 3),
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      message("assistant", "discarded", 4),
      {
        type: "event_msg",
        payload: { type: "thread_rolled_back", num_turns: 1 },
      },
    ];
    await writeFile(
      rolloutPath,
      `${rolledBack.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    expect(await reader.getSessionSummary(sessionId, projectId)).toMatchObject({
      model: "gpt-6-astra",
    });
    expect(codexSummaryScanReadCount()).toBe(3);
  });

  it("drops the oldest summary scan once the cache is full", async () => {
    resetCodexSummaryScanCache();
    const reader = new CodexSessionReader({ sessionsDir });
    const ids = [sessionId];
    for (let index = 1; index < 33; index += 1) {
      const id = randomUUID();
      ids.push(id);
      await writeFile(
        join(sessionsDir, `rollout-${id}.jsonl`),
        `${[meta(id), message("user", `prompt ${index}`, 1)]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );
    }

    for (const id of ids) {
      expect(await reader.getSessionSummary(id, projectId)).toMatchObject({
        id,
      });
    }
    expect(codexSummaryScanReadCount()).toBe(33);

    const newest = ids[32];
    const oldest = ids[0];
    if (!newest || !oldest) throw new Error("expected 33 cached sessions");

    expect(await reader.getSessionSummary(newest, projectId)).toMatchObject({
      id: newest,
    });
    expect(codexSummaryScanReadCount()).toBe(33);

    expect(await reader.getSessionSummary(oldest, projectId)).toMatchObject({
      id: oldest,
    });
    expect(codexSummaryScanReadCount()).toBe(34);
  });
});
