import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type FontSize = "small" | "default" | "large" | "larger";

const fontSizeScales: Record<FontSize, number> = {
  small: 0.85,
  default: 1,
  large: 1.15,
  larger: 1.3,
};

const fontSizeLabels: Record<FontSize, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
  larger: "Larger",
};

export const FONT_SIZES: FontSize[] = ["small", "default", "large", "larger"];

export function getFontSizeLabel(size: FontSize): string {
  return fontSizeLabels[size];
}

function applyFontSize(size: FontSize) {
  const scale = fontSizeScales[size];
  const root = document.documentElement;

  // All typography tokens are rem-based; one scale covers every UI surface.
  // Keep the root percentage so browser zoom and user default sizes still work.
  root.style.fontSize = `${Math.round(100 * scale)}%`;
  // Remove overrides left by older clients during development/HMR.
  for (const token of ["xs", "sm", "base", "lg"]) {
    root.style.removeProperty(`--font-size-${token}`);
  }
}

function loadFontSize(): FontSize {
  const stored = localStorage.getItem(UI_KEYS.fontSize);
  if (stored && FONT_SIZES.includes(stored as FontSize)) {
    return stored as FontSize;
  }
  return "large";
}

function saveFontSize(size: FontSize) {
  localStorage.setItem(UI_KEYS.fontSize, size);
}

/**
 * Hook to manage font size preference.
 * Persists to localStorage and applies CSS variables.
 */
export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSize>(loadFontSize);

  // Apply font size on mount and when it changes
  useEffect(() => {
    applyFontSize(fontSize);
  }, [fontSize]);

  const setFontSize = useCallback((size: FontSize) => {
    setFontSizeState(size);
    saveFontSize(size);
  }, []);

  return { fontSize, setFontSize };
}

/**
 * Initialize font size on app load (call once at startup).
 */
export function initializeFontSize() {
  const size = loadFontSize();
  applyFontSize(size);
}
