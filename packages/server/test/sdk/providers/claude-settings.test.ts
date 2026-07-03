import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClaudeModelCatalog } from "../../../src/sdk/providers/claude-settings.js";

describe("Claude settings model catalog", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.stubEnv("CLAUDE_MODEL_CATALOG_BASE_URL", "");
    vi.stubEnv("CLAUDE_MODEL_CATALOG_API_KEY", "");
    vi.stubEnv("LLM_API_BASE", "");
    vi.stubEnv("LLM_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function writeSettings(settings: unknown): void {
    tempDir = mkdtempSync(join(tmpdir(), "yep-claude-settings-"));
    writeFileSync(join(tempDir, "settings.json"), JSON.stringify(settings));
    vi.stubEnv("CLAUDE_CONFIG_DIR", tempDir);
  }

  it("does not send ambient tokens to the default catalog URL", async () => {
    writeSettings({
      env: {
        ANTHROPIC_AUTH_TOKEN: "anthropic-secret",
      },
    });
    vi.stubEnv("CLAUDE_MODEL_CATALOG_API_KEY", "catalog-secret");
    vi.stubEnv("LLM_API_KEY", "llm-secret");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })));

    await expect(fetchClaudeModelCatalog()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the settings token when an explicit Anthropic base URL is configured", async () => {
    writeSettings({
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.test",
        ANTHROPIC_AUTH_TOKEN: "anthropic-secret",
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-example",
              supported_endpoint_types: ["anthropic"],
            },
          ],
        }),
      ),
    );

    await expect(fetchClaudeModelCatalog()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer anthropic-secret",
        }),
      }),
    );
  });
});
