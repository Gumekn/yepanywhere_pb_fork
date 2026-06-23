import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadConfig codex paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses CODEX_HOME/sessions when CODEX_SESSIONS_DIR is unset", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe("/tmp/custom-codex-home/sessions");
  });

  it("prefers CODEX_SESSIONS_DIR over CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");
    vi.stubEnv("CODEX_SESSIONS_DIR", "/tmp/explicit-codex-sessions");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe("/tmp/explicit-codex-sessions");
  });

  it("falls back to ~/.codex/sessions when neither env var is set", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe(
      path.join(os.homedir(), ".codex", "sessions"),
    );
  });

  it("always allows the managed uploads directory for local-image", async () => {
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual(["/tmp/yep-data/uploads"]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "/tmp, /var/tmp, /tmp");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      "/tmp/yep-data/uploads",
      "/tmp",
      "/var/tmp",
    ]);
  });

  it("uses light Codex bridge upstream args by default and keeps full profile unrestricted", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", undefined);
    vi.stubEnv("CODEX_BRIDGE_UPSTREAM_ARGS", undefined);

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual([
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "-c",
      "mcp_servers.chrome-devtools.enabled=false",
    ]);
    expect(config.codexBridgeFullUpstreamArgs).toEqual([]);
  });

  it("parses profile-specific Codex bridge upstream args from env", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", "");
    vi.stubEnv(
      "YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS",
      '["--enable","apps","-c","x.y=true"]',
    );
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", "--legacy ignored");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual([]);
    expect(config.codexBridgeFullUpstreamArgs).toEqual([
      "--enable",
      "apps",
      "-c",
      "x.y=true",
    ]);
  });

  it("keeps legacy Codex bridge upstream args as a light-profile override only", async () => {
    vi.stubEnv("YEP_CODEX_BRIDGE_LIGHT_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_FULL_UPSTREAM_ARGS", undefined);
    vi.stubEnv("YEP_CODEX_BRIDGE_UPSTREAM_ARGS", "--disable apps");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexBridgeLightUpstreamArgs).toEqual(["--disable", "apps"]);
    expect(config.codexBridgeFullUpstreamArgs).toEqual([]);
  });
});
