import { describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import type { SessionCommandService } from "../../src/services/SessionCommandService.js";

const projectId = encodeProjectId("/test/project");
const path = `/projects/${projectId}/sessions/pi-session/compact`;

function setup(external = false) {
  const compactPiSession = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: { success: true, sessionId: "pi-session", processId: "pi-process" },
  }));
  const routes = createSessionsRoutes({
    supervisor: {} as SessionsDeps["supervisor"],
    scanner: {} as SessionsDeps["scanner"],
    readerFactory: vi.fn(),
    runtimeController: {} as RuntimeController,
    sessionInteractionService: {} as SessionInteractionService,
    sessionCommandService: {
      compactPiSession,
    } as unknown as SessionCommandService,
    externalTracker: {
      isExternal: () => external,
    } as SessionsDeps["externalTracker"],
  });
  const send = (body: string) =>
    routes.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  return { send, compactPiSession };
}

describe("Pi session compaction route", () => {
  it("forwards bounded guidance without accepting a replacement prompt or launch settings", async () => {
    const { send, compactPiSession } = setup();
    const response = await send(
      JSON.stringify({
        customInstructions: "  keep decisions  ",
        message: "do something else",
        resume: { model: "another-model" },
      }),
    );
    expect(response.status).toBe(200);
    expect(compactPiSession).toHaveBeenCalledWith({
      projectId,
      sessionId: "pi-session",
      customInstructions: "keep decisions",
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      processId: "pi-process",
    });
  });

  it.each([
    "{",
    "[]",
    JSON.stringify({ customInstructions: 42 }),
    JSON.stringify({ customInstructions: "x".repeat(4001) }),
  ])("rejects malformed requests before dispatch", async (body) => {
    const { send, compactPiSession } = setup();
    expect((await send(body)).status).toBe(400);
    expect(compactPiSession).not.toHaveBeenCalled();
  });

  it("does not take over an externally controlled session", async () => {
    const { send, compactPiSession } = setup(true);
    expect((await send("{}")).status).toBe(409);
    expect(compactPiSession).not.toHaveBeenCalled();
  });

  it("surfaces startup errors instead of reporting success", async () => {
    const { send, compactPiSession } = setup();
    compactPiSession.mockRejectedValue(new Error("Pi session file is missing"));
    const response = await send("{}");
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Pi session file is missing",
    });
  });
});
