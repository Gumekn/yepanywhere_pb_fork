import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";

const projectId = Buffer.from("/tmp/project").toString(
  "base64url",
) as UrlProjectId;

function createProject(): Project {
  return {
    id: projectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/claude/projects/-tmp-project",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(sessionId: string): SessionSummary {
  return {
    id: sessionId,
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
  };
}

function createFileChange(sessionId: string): BusEvent {
  return {
    type: "file-change",
    provider: "claude",
    path: `/tmp/claude/projects/-tmp-project/${sessionId}.jsonl`,
    relativePath: `projects/-tmp-project/${sessionId}.jsonl`,
    changeType: "modify",
    timestamp: "2026-01-01T00:00:02.000Z",
    fileType: "session",
  };
}

async function flushTrackerWork(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(300);
  await Promise.resolve();
}

describe("ExternalSessionTracker", () => {
  let eventBus: EventBus;
  let events: BusEvent[];
  let tracker: ExternalSessionTracker;
  const project = createProject();

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    events = [];
    eventBus.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    tracker?.dispose();
    vi.useRealTimers();
  });

  function createTracker(
    externalProcessProbe: () => Promise<boolean | null>,
    processValidationMs = 100,
  ): ExternalSessionTracker {
    return new ExternalSessionTracker({
      eventBus,
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        getAllProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
        getProjectBySessionDirSuffix: vi.fn(async () => project),
      } as never,
      decayMs: 10000,
      processValidationMs,
      externalProcessProbe,
      getSessionSummary: vi.fn(async (sessionId) => createSummary(sessionId)),
    });
  }

  it("creates unowned sessions without external ownership when no provider process is active", async () => {
    tracker = createTracker(vi.fn(async () => false));

    eventBus.emit(createFileChange("sess-inactive"));
    await flushTrackerWork();

    expect(tracker.isExternal("sess-inactive")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.ownership.owner === "external",
      ),
    ).toBe(false);

    const created = events.find(
      (event) =>
        event.type === "session-created" &&
        event.session.id === "sess-inactive",
    );
    expect(created?.type).toBe("session-created");
    if (created?.type === "session-created") {
      expect(created.session.ownership).toEqual({ owner: "none" });
    }
  });

  it("marks unowned sessions external when a provider process is active", async () => {
    tracker = createTracker(vi.fn(async () => true));

    eventBus.emit(createFileChange("sess-active"));
    await flushTrackerWork();

    expect(tracker.isExternal("sess-active")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === "sess-active" &&
          event.ownership.owner === "external",
      ),
    ).toBe(true);
  });

  it("clears external ownership when process validation sees the provider process exit", async () => {
    const externalProcessProbe = vi
      .fn<[], Promise<boolean | null>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    tracker = createTracker(externalProcessProbe, 500);

    eventBus.emit(createFileChange("sess-exited"));
    await flushTrackerWork();
    expect(tracker.isExternal("sess-exited")).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(tracker.isExternal("sess-exited")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === "sess-exited" &&
          event.ownership.owner === "none",
      ),
    ).toBe(true);
  });
});
