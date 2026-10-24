import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

it("saves Cursor parameters through the real settings API and restores them from disk without changing Codex defaults", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cursor-defaults-"));
  try {
    const settings = new ServerSettingsService({ dataDir });
    await settings.initialize();
    const routes = createSettingsRoutes({ serverSettingsService: settings });
    const put = (newSessionDefaults: unknown) =>
      routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newSessionDefaults }),
      });
    expect(
      (
        await put({
          provider: "codex",
          model: "gpt-6-astra",
          serviceTier: "priority",
          permissionMode: "bypassPermissions",
        })
      ).status,
    ).toBe(200);
    const cursor = {
      model: "gpt-5.6-sol[context=1m,reasoning=xhigh,fast=true]",
      permissionMode: "plan",
    };
    const response = await put({
      provider: "cursor",
      ...cursor,
      byProvider: { cursor },
    });
    expect(response.status).toBe(200);
    const reloaded = new ServerSettingsService({ dataDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("newSessionDefaults")).toMatchObject({
      provider: "cursor",
      ...cursor,
      byProvider: {
        cursor,
        codex: {
          model: "gpt-6-astra",
          serviceTier: "priority",
          permissionMode: "bypassPermissions",
        },
      },
    });
    expect(
      reloaded.getSetting("newSessionDefaults")?.serviceTier,
    ).toBeUndefined();
    const readRoutes = createSettingsRoutes({
      serverSettingsService: reloaded,
    });
    const read = await readRoutes.request("/");
    expect(read.status).toBe(200);
    expect(
      (await read.json()).settings.newSessionDefaults.byProvider.cursor,
    ).toEqual(cursor);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
