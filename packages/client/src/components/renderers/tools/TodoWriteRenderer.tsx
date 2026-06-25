import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import {
  type ChecklistItem,
  ChecklistPanel,
  getChecklistSummary,
  normalizeChecklistStatus,
} from "./Checklist";
import type {
  Todo,
  TodoWriteInput,
  TodoWriteResult,
  ToolRenderer,
} from "./types";

function todosToChecklistItems(todos: Todo[] | undefined): ChecklistItem[] {
  return (todos ?? [])
    .filter((todo) => typeof todo.content === "string" && todo.content)
    .map((todo) => ({
      label: todo.content,
      status: normalizeChecklistStatus(todo.status),
    }));
}

/**
 * TodoWrite tool use - shows intended todo changes
 */
function TodoWriteToolUse({ input }: { input: TodoWriteInput }) {
  const items = todosToChecklistItems(input?.todos);

  if (items.length === 0) {
    return <div className="task-checklist-empty">No todos specified</div>;
  }

  return <ChecklistPanel title="Tasks" items={items} />;
}

/**
 * TodoWrite tool result - shows the updated todo list
 */
function TodoWriteToolResult({
  result,
  isError,
}: {
  result: TodoWriteResult | string | undefined;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result && typeof result === "object") {
      const validation = validateToolResult("TodoWrite", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("TodoWrite", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("TodoWrite");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    const errorText =
      typeof result === "string" && result.trim()
        ? result.trim()
        : typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to update todos";
    return (
      <div className="todo-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
        )}
        {errorText}
      </div>
    );
  }

  const items = todosToChecklistItems(
    typeof result === "object" ? result?.newTodos : undefined,
  );

  if (items.length === 0) {
    return (
      <div className="task-checklist-empty">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
        )}
        No todos
      </div>
    );
  }

  return (
    <div className="todo-result">
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
      )}
      <ChecklistPanel title="Tasks" items={items} />
    </div>
  );
}

export const todoWriteRenderer: ToolRenderer<TodoWriteInput, TodoWriteResult> =
  {
    tool: "TodoWrite",
    displayName: "Update Todos",

    renderToolUse(input, _context) {
      return <TodoWriteToolUse input={input as TodoWriteInput} />;
    },

    renderToolResult(result, isError, _context) {
      return (
        <TodoWriteToolResult
          result={result as TodoWriteResult}
          isError={isError}
        />
      );
    },

    getUseSummary(input) {
      const items = todosToChecklistItems((input as TodoWriteInput).todos);
      return items.length > 0 ? getChecklistSummary(items) : "Todos";
    },

    renderInline(input, result, isError, status) {
      if (status === "pending" || status === "aborted" || !result) {
        return <TodoWriteToolUse input={input as TodoWriteInput} />;
      }
      return (
        <TodoWriteToolResult
          result={result as TodoWriteResult | string | undefined}
          isError={isError}
        />
      );
    },

    getResultSummary(result, isError) {
      if (isError) return "Error";
      const r = result as TodoWriteResult;
      const items = todosToChecklistItems(r?.newTodos);
      return items.length > 0 ? getChecklistSummary(items) : "Todos";
    },
  };
