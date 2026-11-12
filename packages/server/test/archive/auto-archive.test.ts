import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { shouldSkipAutoArchiveForPinnedSession } from "../../src/app.js";
import { SessionArchiveService } from "../../src/archive/index.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import {
  type SessionSummary,
  encodeProjectId,
} from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("auto archive guards", () => {
  it("skips sessions pinned in persisted metadata", () => {
    expect(
      shouldSkipAutoArchiveForPinnedSession(
        { isStarred: false },
        { isStarred: true },
      ),
    ).toBe(true);
  });

  it("skips sessions pinned in session summaries", () => {
    expect(
      shouldSkipAutoArchiveForPinnedSession({ isStarred: true }, undefined),
    ).toBe(true);
  });

  it("allows unpinned sessions to be auto-archived", () => {
    expect(
      shouldSkipAutoArchiveForPinnedSession({ isStarred: false }, undefined),
    ).toBe(false);
  });
});

describe("Codex auto archive integration", () => {
  it.each([true, false])(
    "preserves source files (metadata available: %s)",
    async (withMetadata) => {
      const dir = await mkdtemp(join(tmpdir(), "codex-auto-archive-"));
      const archive = new SessionArchiveService({ dataDir: dir });
      const metadata = new SessionMetadataService({ dataDir: dir });
      const projectId = encodeProjectId(dir);
      const content = '{"type":"session_meta","payload":{"id":"old"}}\n';
      const source = join(dir, "rollout.jsonl");
      let app: ReturnType<typeof createApp> | undefined;
      try {
        await archive.initialize();
        await metadata.initialize();
        await writeFile(source, content);
        const before = await stat(source);
        await metadata.updateMetadata("pinned", { starred: true });
        await metadata.setArchived("already", true);
        const summaries: SessionSummary[] = [
          "old",
          "pinned",
          "fresh",
          "already",
          "active",
        ].map((id) => ({
          id,
          projectId,
          title: id,
          fullTitle: id,
          createdAt: "2020-01-01T00:00:00Z",
          updatedAt:
            id === "fresh" ? new Date().toISOString() : "2020-01-01T00:00:00Z",
          messageCount: 2,
          ownership: { owner: "none" },
          provider: "codex",
        }));
        vi.spyOn(ProjectScanner.prototype, "listProjects").mockResolvedValue([
          {
            id: projectId,
            path: dir,
            name: "test",
            sessionDir: dir,
            provider: "codex",
            sessionCount: 5,
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
          },
        ]);
        vi.spyOn(
          CodexSessionReader.prototype,
          "listSessions",
        ).mockResolvedValue(summaries);
        const lookup = vi
          .spyOn(CodexSessionReader.prototype, "getSessionFilePath")
          .mockResolvedValue(source);
        const physical = vi.spyOn(archive, "archiveSession");
        const scheduler = vi
          .spyOn(archive, "startDailyScheduler")
          .mockImplementation(() => {});
        const eventBus = new EventBus();
        const emit = vi.spyOn(eventBus, "emit");
        app = createApp({
          sdk: new MockClaudeSDK(),
          dataDir: dir,
          projectsDir: dir,
          enabledProviders: ["codex"],
          sessionArchiveService: archive,
          sessionMetadataService: withMetadata ? metadata : undefined,
          eventBus,
        });
        vi.spyOn(
          app.runtimeController,
          "getProcessForSession",
        ).mockImplementation(async (id) =>
          id === "active" ? ({ id: "active" } as never) : undefined,
        );
        const scan = scheduler.mock.calls[0]?.[0];
        if (!scan) throw new Error("Scheduler was not installed");
        await scan();
        await scan();
        expect(await readFile(source, "utf8")).toBe(content);
        expect((await stat(source)).mtimeMs).toBe(before.mtimeMs);
        expect(physical).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
        expect(archive.listArchivedSessions()).toEqual([]);
        expect(metadata.getMetadata("old")?.isArchived).toBe(
          withMetadata ? true : undefined,
        );
        expect(metadata.getMetadata("pinned")?.isArchived).toBeUndefined();
        expect(metadata.getMetadata("fresh")?.isArchived).toBeUndefined();
        expect(metadata.getMetadata("active")?.isArchived).toBeUndefined();
        expect(
          emit.mock.calls.some(([event]) => event.type === "file-change"),
        ).toBe(false);
        expect(
          emit.mock.calls.filter(
            ([event]) => event.type === "session-metadata-changed",
          ),
        ).toHaveLength(withMetadata ? 1 : 0);
      } finally {
        await app?.supervisor.shutdown();
        archive.stopDailyScheduler();
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
