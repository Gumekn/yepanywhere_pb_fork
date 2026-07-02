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
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "X-Sub-Module",
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).max_tokens,
    ).toBe(100000);
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

  it("sends a configured submodule header", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重构重复逻辑"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      subModule: "claude-code-internal",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "X-Sub-Module",
      "claude-code-internal",
    );
  });

  it("uses the first real user message instead of the summary title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"真实用户问题标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          title: "Stale summary title",
          fullTitle: "Stale full summary title",
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content: "Actual first user prompt",
              },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "Actual assistant response",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain("Actual first user prompt");
    expect(prompt).not.toContain("Stale full summary title");
  });

  it("waits for Codex final answer instead of titling from commentary", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"最终回答标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Move questions to backend" },
            },
            {
              type: "assistant",
              codexMessagePhase: "commentary",
              message: {
                role: "assistant",
                content: "I will inspect the code first.",
              },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content:
                  "Implemented backend-owned session questions and updated the inspector.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain(
      "Implemented backend-owned session questions and updated the inspector.",
    );
    expect(prompt).not.toContain("I will inspect the code first.");
  });

  it("does not generate a Codex title before the final answer is present", async () => {
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Move questions to backend" },
            },
            {
              type: "assistant",
              codexMessagePhase: "commentary",
              message: {
                role: "assistant",
                content: "I will inspect the code first.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata("session-1")).toBeUndefined();
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
