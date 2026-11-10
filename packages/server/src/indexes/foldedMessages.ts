/**
 * Which indexed messages stay visible in the session view.
 *
 * Settled answers show only their final text; the progress text written
 * between tool calls folds behind a process summary. Content search skips
 * that folded text by default, so the classification reuses the display
 * reducer itself instead of re-implementing its folding rules.
 */

import { SessionDisplayReducer } from "../display/SessionDisplayReducer.js";
import type { Message } from "../supervisor/types.js";

/**
 * Source ids of assistant messages whose text is shown outside any folded
 * process. The session is treated as settled, matching how history is
 * displayed. Returns null when the projection cannot be built, in which case
 * callers should treat every message as visible.
 */
export function findVisibleAssistantMessageIds(
  sessionId: string,
  provider: string | undefined,
  messages: readonly Message[],
): Set<string> | null {
  try {
    const model = new SessionDisplayReducer(
      { sessionId, branchScopeId: "search", epoch: "search" },
      provider,
      { foldSettled: true },
    );
    model.restore(messages);
    model.setRuntime("completed");
    const visible = new Set<string>();
    for (const node of model.snapshot().nodes) {
      if (
        node.type === "segment" &&
        node.segment.type === "assistant_text" &&
        node.segment.messageId
      )
        visible.add(node.segment.messageId);
    }
    return visible;
  } catch {
    return null;
  }
}
