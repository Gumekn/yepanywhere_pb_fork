export const CODEX_TURN_ABORTED_DISPLAY_TEXT = "Conversation stopped by user";

const CODEX_TURN_ABORTED_NOTICE_PATTERN =
  /^<turn_aborted>\s*[\s\S]*<\/turn_aborted>$/;

export function isCodexTurnAbortedNoticeText(text: string): boolean {
  return CODEX_TURN_ABORTED_NOTICE_PATTERN.test(text.trim());
}
