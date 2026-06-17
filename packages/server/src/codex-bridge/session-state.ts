import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import type { SessionOwnership } from "../supervisor/types.js";
import type { CodexBridgeSession, CodexBridgeSessionView } from "./types.js";

export function hasLiveBridgeActivity(state: {
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}): boolean {
  return (
    state.activity === "in-turn" ||
    state.activity === "waiting-input" ||
    Boolean(state.pendingInputType)
  );
}

export function isLiveBridgeSession(
  session: Pick<
    CodexBridgeSession,
    "connectionIds" | "activity" | "pendingInputType"
  >,
): boolean {
  return session.connectionIds.length > 0;
}

export function isLiveBridgeSessionView(
  view: Pick<
    CodexBridgeSessionView,
    "session" | "activity" | "pendingInputType"
  >,
): boolean {
  if (view.session.ownership.owner === "external") return true;
  return hasLiveBridgeActivity(view);
}

export function bridgeOwnership(isLive: boolean): SessionOwnership {
  return isLive ? { owner: "external" } : { owner: "none" };
}
