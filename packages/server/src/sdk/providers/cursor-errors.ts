/** Cursor ACP reports backend failures as standalone text, then end_turn. */
export function cursorStreamError(
  text: unknown,
): { message: string; code: string } | null {
  if (typeof text !== "string") return null;
  const match =
    /^\s*Error:\s+(?:RetriableError:\s*)?\[(resource_exhausted|unavailable|deadline_exceeded|unauthenticated|permission_denied|internal|unknown|aborted)\][^\n]*\s*$/.exec(
      text,
    );
  return match?.[1]
    ? { message: text.trim(), code: `cursor.${match[1]}` }
    : null;
}
