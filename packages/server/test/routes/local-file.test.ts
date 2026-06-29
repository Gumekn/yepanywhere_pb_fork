import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalFileRoutes } from "../../src/routes/local-file.js";

describe("Local file routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves markdown files from allowed directories and preserves line metadata", async () => {
    const codexDir = path.join(tempDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    const filePath = path.join(codexDir, "AGENTS.md");
    await writeFile(filePath, "# Agent Rules\n\nUse rg first.");

    const routes = createLocalFileRoutes({
      allowedPaths: [codexDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(`${filePath}:3`)}`,
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      metadata: {
        path: filePath,
        mimeType: "text/markdown",
        isText: true,
      },
      content: "# Agent Rules\n\nUse rg first.",
      lineNumber: 3,
    });
    expect(json.renderedMarkdownHtml).toContain("<h1>Agent Rules</h1>");
  });

  it("rejects markdown files outside allowed directories", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    const otherDir = path.join(tempDir, "other");
    await mkdir(allowedDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    const filePath = path.join(otherDir, "AGENTS.md");
    await writeFile(filePath, "# Outside");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Path not in allowed directories",
    });
  });

  it("rejects unsupported local file extensions", async () => {
    const allowedDir = path.join(tempDir, ".codex");
    await mkdir(allowedDir, { recursive: true });
    const filePath = path.join(allowedDir, "auth.json");
    await writeFile(filePath, "{}");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Not a supported local text file type",
    });
  });
});
