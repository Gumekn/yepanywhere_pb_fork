import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticRoutes } from "../../src/frontend/static.js";

describe("static frontend routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-static-"));
    await mkdir(path.join(tempDir, "assets"), { recursive: true });
    await writeFile(path.join(tempDir, "index.html"), "<div>app</div>");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves Vite hashed assets with long browser and CDN cache headers", async () => {
    await writeFile(
      path.join(tempDir, "assets", "index-CREDb_As.js"),
      "console.log('app');",
    );

    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const response = await routes.request("/yep/assets/index-CREDb_As.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("cdn-cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
  });

  it("keeps non-hashed assets revalidated", async () => {
    await writeFile(path.join(tempDir, "assets", "logo.svg"), "<svg></svg>");

    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const response = await routes.request("/yep/assets/logo.svg");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.has("cdn-cache-control")).toBe(false);
    expect(response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
  });

  it("serves the SPA shell without long caching", async () => {
    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const response = await routes.request("/yep/sessions");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
  });
});
