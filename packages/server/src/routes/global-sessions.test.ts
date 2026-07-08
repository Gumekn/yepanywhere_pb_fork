import { describe, expect, it } from "vitest";
import { encodeProjectId } from "../projects/paths.js";
import { resolveSessionProjectName } from "./global-sessions.js";

describe("resolveSessionProjectName", () => {
  it("uses the project matching the session projectId instead of the scanning project", () => {
    const actualProjectId = encodeProjectId("/tmp/project-b");
    const projectById = new Map([
      [encodeProjectId("/tmp/project-a"), { name: "project-a" }],
      [actualProjectId, { name: "project-b" }],
    ]);

    expect(
      resolveSessionProjectName(
        actualProjectId,
        { name: "project-a" },
        projectById,
      ),
    ).toBe("project-b");
  });

  it("decodes unknown project IDs before falling back to the scanning project", () => {
    const projectById = new Map<string, { name: string }>();

    expect(
      resolveSessionProjectName(
        encodeProjectId("/tmp/project-c"),
        { name: "project-a" },
        projectById,
      ),
    ).toBe("project-c");
  });
});
