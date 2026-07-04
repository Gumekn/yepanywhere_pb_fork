import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, fetchJSON } from "./client";

describe("api.updateServerSettings", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          serviceWorkerEnabled: true,
        },
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes undefined setting values as null so clears reach the server", async () => {
    await api.updateServerSettings({
      globalInstructions: undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(JSON.stringify({ globalInstructions: null }));
  });
});

describe("fetchJSON errors", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("preserves structured archive block details", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      json: async () => ({
        error: "This session is waiting for input.",
        code: "waiting_input",
        runtime: {
          ownership: { owner: "self", processId: "proc-1" },
          activity: "waiting-input",
          isBusy: true,
          hasResidentWorker: false,
          canArchive: false,
          archiveBlockCode: "waiting_input",
          archiveBlockReason: "This session is waiting for input.",
        },
      }),
    } as Response);

    await expect(
      fetchJSON("/sessions/session-1/metadata"),
    ).rejects.toMatchObject({
      message: "This session is waiting for input.",
      status: 409,
      code: "waiting_input",
      runtime: {
        canArchive: false,
        activity: "waiting-input",
      },
    });
  });
});
