import {
  type ChecklistItem,
  ChecklistPanel,
  getChecklistSummary,
  normalizeChecklistStatus,
} from "./Checklist";
import type {
  ToolRenderer,
  UpdatePlanInput,
  UpdatePlanResult,
  UpdatePlanStep,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractPlanSteps(input: unknown): ChecklistItem[] {
  if (!isRecord(input) || !Array.isArray(input.plan)) {
    return [];
  }

  return input.plan
    .filter(
      (item): item is UpdatePlanStep =>
        isRecord(item) && typeof item.step === "string",
    )
    .map((item) => ({
      label: item.step,
      status: normalizeChecklistStatus(item.status),
    }));
}

function extractExplanation(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.explanation !== "string") {
    return undefined;
  }
  const explanation = input.explanation.trim();
  return explanation.length > 0 ? explanation : undefined;
}

function extractResultMessage(result: unknown): string | undefined {
  if (typeof result === "string") {
    const message = result.trim();
    return message.length > 0 ? message : undefined;
  }

  if (isRecord(result) && typeof result.message === "string") {
    const message = result.message.trim();
    return message.length > 0 ? message : undefined;
  }

  return undefined;
}

export const updatePlanRenderer: ToolRenderer<
  UpdatePlanInput,
  UpdatePlanResult
> = {
  tool: "UpdatePlan",
  displayName: "Update plan",

  renderToolUse() {
    return null;
  },

  renderToolResult() {
    return null;
  },

  renderInline(input, result, isError, status) {
    const steps = extractPlanSteps(input);
    const explanation = extractExplanation(input);
    const resultMessage = extractResultMessage(result);

    if (isError) {
      return (
        <div className="todo-error">
          {resultMessage || "Failed to update plan"}
        </div>
      );
    }

    if (steps.length === 0) {
      if (status === "pending") {
        return <div className="task-checklist-empty">Updating plan...</div>;
      }
      return (
        <div className="task-checklist-empty">
          {resultMessage || "Plan updated"}
        </div>
      );
    }

    const trailingMessage =
      status !== "pending" &&
      resultMessage &&
      resultMessage.toLowerCase() !== "plan updated"
        ? resultMessage
        : undefined;

    return (
      <ChecklistPanel
        title="Plan"
        items={steps}
        note={explanation}
        trailingMessage={trailingMessage}
      />
    );
  },

  getUseSummary(input) {
    const steps = extractPlanSteps(input);
    if (steps.length === 0) {
      return "Update plan";
    }
    return getChecklistSummary(steps);
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }
    return extractResultMessage(result) || "Plan updated";
  },
};
