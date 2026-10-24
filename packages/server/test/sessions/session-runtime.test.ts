import { describe, expect, it } from "vitest";
import {
  pendingInputTypeFromProcess,
  pendingInputTypeFromRequest,
} from "../../src/sessions/session-runtime.js";

describe("pendingInputTypeFromRequest", () => {
  it("keeps tool approval and folds every other request into a user question", () => {
    expect(pendingInputTypeFromRequest({ type: "tool-approval" })).toBe(
      "tool-approval",
    );
    expect(pendingInputTypeFromRequest({ type: "question" })).toBe(
      "user-question",
    );
    expect(pendingInputTypeFromRequest({ type: "choice" })).toBe(
      "user-question",
    );
    expect(pendingInputTypeFromRequest(null)).toBeUndefined();
    expect(pendingInputTypeFromRequest(undefined)).toBeUndefined();
  });

  it("reads a resident request before the process getter", () => {
    expect(
      pendingInputTypeFromProcess({
        id: "process-1",
        state: "waiting-input",
        pendingInputRequest: { type: "tool-approval", id: "req-1" },
        getPendingInputRequest: () => ({ type: "question", id: "req-2" }),
      }),
    ).toBe("tool-approval");
    expect(
      pendingInputTypeFromProcess({
        id: "process-2",
        state: "waiting-input",
        getPendingInputRequest: () => ({ type: "question", id: "req-2" }),
      }),
    ).toBe("user-question");
    expect(pendingInputTypeFromProcess(null)).toBeUndefined();
  });
});
