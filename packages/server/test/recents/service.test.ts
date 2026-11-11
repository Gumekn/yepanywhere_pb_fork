import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentsService } from "../../src/recents/RecentsService.js";

describe("RecentsService", () => {
  let testDir: string;
  let service: RecentsService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `recents-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    service = new RecentsService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("moves visits from a temporary ID onto its durable ID", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-06T08:37:00Z") });
    await service.recordVisit("durable-id", "project");
    vi.setSystemTime(new Date("2026-11-06T08:37:30Z"));
    await service.recordVisit("other-id", "project");
    vi.setSystemTime(new Date("2026-11-06T08:38:00Z"));
    await service.recordVisit("temporary-id", "project");

    await service.remapSessionId("temporary-id", "durable-id");

    expect(service.getRecents()).toEqual([
      {
        sessionId: "durable-id",
        projectId: "project",
        visitedAt: "2026-11-06T08:38:00.000Z",
      },
      {
        sessionId: "other-id",
        projectId: "project",
        visitedAt: "2026-11-06T08:37:30.000Z",
      },
    ]);
    const persisted = JSON.parse(
      await fs.readFile(join(testDir, "recents.json"), "utf-8"),
    ) as { visits: { sessionId: string }[] };
    expect(persisted.visits.map((visit) => visit.sessionId)).toEqual([
      "durable-id",
      "other-id",
    ]);
  });

  it("leaves visits untouched when the temporary ID was never visited", async () => {
    await service.recordVisit("durable-id", "project");
    const before = service.getRecents();
    await service.remapSessionId("temporary-id", "durable-id");
    expect(service.getRecents()).toEqual(before);
  });
});
