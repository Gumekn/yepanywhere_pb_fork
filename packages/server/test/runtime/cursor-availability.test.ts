import { describe, expect, it } from "vitest";
import {
  CURSOR_RUNTIME_VERSION,
  getCursorRuntimeAvailability,
} from "../../src/runtime/cursor-availability.js";

describe("resident Cursor integration version", () => {
  it.each([undefined, 0, 1, CURSOR_RUNTIME_VERSION])(
    "checks the resident capability version %s, not only the provider name",
    async (version) => {
      expect(
        await getCursorRuntimeAvailability({
          mode: "external",
          getStatus: async () => ({
            mode: "embedded",
            protocolVersion: 6,
            processCount: 0,
            activeWorkers: 0,
            queueLength: 0,
            hasActiveWork: false,
            availableProviders: ["cursor"],
            providerVersions:
              version === undefined ? undefined : { cursor: version },
          }),
        }),
      ).toBe(
        version === CURSOR_RUNTIME_VERSION
          ? "ready"
          : "runtime-update-required",
      );
    },
  );
});
