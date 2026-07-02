import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { SessionTitleService } from "../../src/services/SessionTitleService.js";
import type { Session } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    projectId: "project-1" as UrlProjectId,
    title: "Please help me refactor a very long piece of code",
    fullTitle: "Please help me refactor a very long piece of code",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "claude",
    messages: [
      {
        type: "user",
        message: {
          role: "user",
          content: "Please help me refactor a very long piece of code",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I found the duplicated logic." }],
        },
      },
    ],
    ...overrides,
  };
}

describe("SessionTitleService", () => {
  let testDir: string;
  let metadataService: SessionMetadataService;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-title-service-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    metadataService = new SessionMetadataService({ dataDir: testDir });
    await metadataService.initialize();
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("generates and stores an AI title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重构重复逻辑"}' } }],
        }),
        { status: 200 },
      );
    });
    const events: unknown[] = [];
    eventBus.subscribe((event) => events.push(event));
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiBase: "https://api.example.com",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
      "重构重复逻辑",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "session-1",
        aiTitle: "重构重复逻辑",
      }),
    );
  });

  it("does not overwrite a custom title", async () => {
    await metadataService.setTitle("session-1", "Manual Title");
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata("session-1")).toEqual({
      customTitle: "Manual Title",
    });
  });

  it("skips slash command sessions", async () => {
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          title: "/commit",
          fullTitle: "/commit",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "/commit" },
            },
            {
              type: "assistant",
              message: { role: "assistant", content: "Done." },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata("session-1")).toBeUndefined();
  });
});
