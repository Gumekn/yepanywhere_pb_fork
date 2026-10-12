import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { initializeFontSize, useFontSize } from "../useFontSize";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

it("restores the user's root scale and clears legacy per-token pixel overrides", () => {
  localStorage.setItem(UI_KEYS.fontSize, "larger");
  document.documentElement.style.setProperty("--font-size-base", "13px");
  initializeFontSize();
  expect(document.documentElement.style.fontSize).toBe("130%");
  expect(
    document.documentElement.style.getPropertyValue("--font-size-base"),
  ).toBe("");
});

it("switches settings without compounding the scale or replacing the token ramp", () => {
  const { result } = renderHook(() => useFontSize());
  expect(result.current.fontSize).toBe("large");
  act(() => result.current.setFontSize("small"));
  expect(document.documentElement.style.fontSize).toBe("85%");
  act(() => result.current.setFontSize("larger"));
  act(() => result.current.setFontSize("default"));
  expect(document.documentElement.style.fontSize).toBe("100%");
  expect(
    document.documentElement.style.getPropertyValue("--font-size-lg"),
  ).toBe("");
  expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("default");
});
