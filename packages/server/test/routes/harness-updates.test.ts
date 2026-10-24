import { describe, expect, it, vi } from "vitest";
import { createHarnessUpdateRoutes } from "../../src/routes/harness-updates.js";
import { HarnessUpdateService } from "../../src/services/HarnessUpdateService.js";

describe("harness update routes", () => {
  function setup(enabledProviders?: string[], dshEnabled = false) {
    const service = new HarnessUpdateService();
    const getInfo = vi
      .spyOn(service, "getInfo")
      .mockImplementation(async (id) => ({
        id,
        displayName: id,
        canUpdate: false,
        updateAvailable: false,
      }));
    const check = vi.spyOn(service, "check").mockImplementation(getInfo);
    const start = vi.spyOn(service, "start").mockReturnValue({
      id: "job-1",
      status: "running",
      startedAt: "2026-10-08",
      log: "",
    });
    return {
      routes: createHarnessUpdateRoutes({
        service,
        enabledProviders,
        dshEnabled,
      }),
      getInfo,
      check,
      start,
    };
  }

  it("lists only enabled harnesses and allows the Codex OSS alias", async () => {
    const { routes, getInfo } = setup(["codex-oss"]);
    const response = await routes.request("/");
    expect((await response.json()).harnesses).toHaveLength(1);
    expect(getInfo).toHaveBeenCalledWith("codex");
    expect(
      (await routes.request("/pi/update", { method: "POST" })).status,
    ).toBe(404);
  });

  it("rejects arbitrary provider names and action names before executing anything", async () => {
    const { routes, start, check } = setup();
    for (const path of [
      "/claude/update",
      "/npm/update",
      "/codex/install",
      "/codex%3Becho/update",
    ]) {
      expect((await routes.request(path, { method: "POST" })).status).toBe(404);
    }
    expect(start).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect((await routes.request("/codex/update")).status).toBe(404);
  });

  it("accepts a background update and ignores client-supplied commands and versions", async () => {
    const { routes, start } = setup();
    const response = await routes.request("/pi/update", {
      method: "POST",
      body: JSON.stringify({ command: "unexpected", version: "malicious" }),
    });
    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledWith("pi");
    expect((await response.json()).job.id).toBe("job-1");
  });

  it("returns a conflict while another update is running", async () => {
    const { routes, start } = setup();
    start.mockReturnValue(null);
    expect(
      (await routes.request("/codex/update", { method: "POST" })).status,
    ).toBe(409);
  });

  it("lists DSH as a Web integration independently of provider allowlists", async () => {
    const { routes, check } = setup(["pi"], true);
    const response = await routes.request("/");
    expect(
      (await response.json()).harnesses.map((item: { id: string }) => item.id),
    ).toEqual(["pi", "dsh"]);
    expect(
      (await routes.request("/dsh/check", { method: "POST" })).status,
    ).toBe(200);
    expect(check).toHaveBeenCalledWith("dsh");
    expect(
      (await setup().routes.request("/dsh/update", { method: "POST" })).status,
    ).toBe(404);
  });
});
