import { afterEach, describe, expect, it, vi } from "vitest";

const installPiFileOperationTools = vi.fn(async () => undefined);

vi.mock("../../resources/pi-file-operations.mjs", () => ({
  installPiFileOperationTools,
}));

const DIRECTORY_KEY = Symbol.for("yep.pi.file-operations-directory.v1");
const PROVIDER_KEY = Symbol.for("yep.pi.provider-config.v1");

function resetState(): void {
  const state = globalThis as Record<PropertyKey, unknown>;
  delete state[DIRECTORY_KEY];
  delete state[PROVIDER_KEY];
}

function fakePi() {
  return { registerProvider: vi.fn(), registerTool: vi.fn(), on: vi.fn() };
}

describe("Pi extension file operation capture", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    installPiFileOperationTools.mockClear();
    resetState();
  });

  it("keeps capturing after a native fork reloads the extension", async () => {
    resetState();
    vi.stubEnv("YEP_PI_FILE_OPERATIONS_DIRECTORY", "/tmp/yep-pi-ingress");
    const extension = await import("../../resources/pi-yep-extension.mjs");

    await extension.default(fakePi());
    // Tool subprocesses inherit process.env, so the directory is scrubbed.
    expect(process.env.YEP_PI_FILE_OPERATIONS_DIRECTORY).toBeUndefined();

    // Pi's fork/new-session path re-runs the factory without the env var.
    await extension.default(fakePi());

    expect(installPiFileOperationTools).toHaveBeenCalledTimes(2);
    for (const [, directory] of installPiFileOperationTools.mock.calls) {
      expect(directory).toBe("/tmp/yep-pi-ingress");
    }
  });
});
