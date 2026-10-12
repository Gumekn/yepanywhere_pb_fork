/** Finish a pending handoff from the retired floating new-session composer. */
const LEGACY_PREFILL_KEY = "fab-prefill";

export function getLegacySessionPrefill(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(LEGACY_PREFILL_KEY);
}

export function clearLegacySessionPrefill(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(LEGACY_PREFILL_KEY);
}
