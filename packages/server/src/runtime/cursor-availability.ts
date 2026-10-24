import type { RuntimeController } from "./types.js";

export const CURSOR_RUNTIME_VERSION = 3;

/** Provider discovery alone cannot prove that a resident runtime has current fixes. */
export async function getCursorRuntimeAvailability(
  runtime: Pick<RuntimeController, "mode" | "getStatus">,
): Promise<"ready" | "runtime-update-required" | "runtime-unavailable"> {
  if (runtime.mode !== "external") return "ready";
  try {
    const status = await runtime.getStatus();
    return status.availableProviders?.includes("cursor") &&
      (status.providerVersions?.cursor ?? 0) >= CURSOR_RUNTIME_VERSION
      ? "ready"
      : "runtime-update-required";
  } catch {
    return "runtime-unavailable";
  }
}
