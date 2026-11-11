import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

/**
 * End-to-end through the real app: the share capture replays the session
 * detail route in-process, so this guards the wiring (base path, internal
 * auth marker, route precedence) that unit tests stub out.
 */
describe("session shares through createApp", () => {
  const projectPath = "/home/user/shareproject";
  let testDir: string;
  let dataDir: string;
  let projectId: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `share-app-${randomUUID()}`);
    dataDir = join(testDir, "data");
    const projectDir = join(
      testDir,
      "projects",
      "localhost",
      projectPath.replaceAll("/", "-"),
    );
    projectId = encodeProjectId(projectPath);
    await mkdir(projectDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const first = randomUUID();
    await writeFile(
      join(projectDir, "sess-1.jsonl"),
      `${[
        JSON.stringify({
          type: "user",
          uuid: first,
          parentUuid: null,
          cwd: projectPath,
          message: { role: "user", content: "Map the project" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: randomUUID(),
          parentUuid: first,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Here is the map." }],
          },
        }),
      ].join("\n")}\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("captures, serves and revokes a share under a base path", async () => {
    const { app } = createApp({
      sdk: new MockClaudeSDK(),
      projectsDir: join(testDir, "projects"),
      dataDir,
      basePath: "/yep",
    });
    const env = {};

    const transcript = await app.request(
      `/yep/api/projects/${projectId}/sessions/sess-1/transcript`,
      undefined,
      env,
    );
    expect(transcript.status).toBe(200);
    const markdown = await transcript.text();
    expect(markdown).toContain("Map the project");
    expect(markdown).toContain("Here is the map.");

    const created = await app.request(
      "/yep/api/session-shares",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({
          projectId,
          sessionId: "sess-1",
          expiresIn: "7d",
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as {
      share: { token: string; messageCount: number };
    };
    expect(share.messageCount).toBe(2);

    const publicView = await app.request(
      `/yep/api/public/session-shares/${share.token}`,
      undefined,
      env,
    );
    expect(publicView.status).toBe(200);
    const body = (await publicView.json()) as {
      snapshot: { messages: unknown[]; session: Record<string, unknown> };
    };
    expect(body.snapshot.messages).toHaveLength(2);
    expect(body.snapshot.session.projectName).toBe("shareproject");

    const revoked = await app.request(
      `/yep/api/session-shares/${share.token}`,
      { method: "DELETE", headers: { "X-Yep-Anywhere": "true" } },
      env,
    );
    expect(revoked.status).toBe(200);
    const gone = await app.request(
      `/yep/api/public/session-shares/${share.token}`,
      undefined,
      env,
    );
    expect(gone.status).toBe(404);
  });
});
