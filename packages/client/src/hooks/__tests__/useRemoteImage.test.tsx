import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("useRemoteImage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("prefixes API image URLs with the Vite base path", async () => {
    vi.stubEnv("BASE_URL", "/yep/");
    vi.resetModules();

    const { preloadRemoteImage, useRemoteImage } = await import(
      "../useRemoteImage"
    );
    const apiUrl = "/api/projects/proj-123/sessions/sess-456/upload/image.png";

    const { result } = renderHook(() => useRemoteImage(apiUrl));

    expect(result.current.url).toBe(
      "/yep/api/projects/proj-123/sessions/sess-456/upload/image.png",
    );
    await expect(preloadRemoteImage(apiUrl)).resolves.toBe(
      "/yep/api/projects/proj-123/sessions/sess-456/upload/image.png",
    );
  });

  it("does not duplicate an already-prefixed API image URL", async () => {
    vi.stubEnv("BASE_URL", "/yep/");
    vi.resetModules();

    const { useRemoteImage } = await import("../useRemoteImage");
    const { result } = renderHook(() =>
      useRemoteImage("/yep/api/local-image?path=%2Ftmp%2Fshot.png"),
    );

    expect(result.current.url).toBe(
      "/yep/api/local-image?path=%2Ftmp%2Fshot.png",
    );
  });
});
