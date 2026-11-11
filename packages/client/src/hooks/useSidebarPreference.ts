import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * Hook to manage sidebar expanded/collapsed preference.
 * Persists to localStorage.
 */
export function useSidebarPreference(): {
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
} {
  const [isExpanded, setIsExpandedState] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(UI_KEYS.sidebarExpanded);
      // Default to expanded if no preference saved
      return stored === null ? true : stored === "true";
    }
    return true;
  });

  const setIsExpanded = useCallback((expanded: boolean) => {
    setIsExpandedState(expanded);
    localStorage.setItem(UI_KEYS.sidebarExpanded, String(expanded));
  }, []);

  const toggleExpanded = useCallback(() => {
    // Use functional update to avoid stale closure issues
    setIsExpandedState((prev) => {
      const next = !prev;
      localStorage.setItem(UI_KEYS.sidebarExpanded, String(next));
      return next;
    });
  }, []);

  return { isExpanded, setIsExpanded, toggleExpanded };
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : stored === "true";
}

/**
 * Whether the sidebar's page links (All Sessions, Search, Settings, …) are
 * unfolded. Desktop has room for them, so they start open there; the mobile
 * drawer starts folded so recent sessions fit on the first screen. Each
 * layout remembers its own choice because one browser may use both.
 */
export function useSidebarNavPreference(isDesktop: boolean): {
  isExpanded: boolean;
  toggleExpanded: () => void;
} {
  const storageKey = isDesktop
    ? UI_KEYS.sidebarNavExpandedDesktop
    : UI_KEYS.sidebarNavExpandedMobile;
  const [state, setState] = useState(() => ({
    storageKey,
    expanded: readStoredFlag(storageKey, isDesktop),
  }));
  const isExpanded =
    state.storageKey === storageKey
      ? state.expanded
      : readStoredFlag(storageKey, isDesktop);

  const toggleExpanded = useCallback(() => {
    const next = !isExpanded;
    setState({ storageKey, expanded: next });
    localStorage.setItem(storageKey, String(next));
  }, [isExpanded, storageKey]);

  return { isExpanded, toggleExpanded };
}
