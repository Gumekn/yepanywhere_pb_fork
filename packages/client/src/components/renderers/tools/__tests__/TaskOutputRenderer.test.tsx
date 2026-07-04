import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaValidationProvider } from "../../../../contexts/SchemaValidationContext";
import { ToastProvider } from "../../../../contexts/ToastContext";
import { taskOutputRenderer } from "../TaskOutputRenderer";
import type { TaskOutputResult } from "../types";

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

function renderWithProviders(ui: ReactNode) {
  return render(
    <ToastProvider>
      <SchemaValidationProvider>{ui}</SchemaValidationProvider>
    </ToastProvider>,
  );
}

describe("TaskOutputRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Claude Code local agent output as markdown when augmented HTML exists", () => {
    renderWithProviders(
      <div>
        {taskOutputRenderer.renderInline?.(
          { task_id: "agent-1", block: true },
          {
            retrieval_status: "success",
            task: {
              task_id: "agent-1",
              task_type: "local_agent",
              status: "completed",
              description: "调研 explore 内容",
              output: "## Finding\n\n- Detail",
              exitCode: null,
              _renderedOutputHtml: "<h2>Finding</h2>\n<ul><li>Detail</li></ul>",
            },
          },
          false,
          "complete",
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText(/success/)).toBeDefined();
    expect(screen.getByText("local_agent")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Finding" })).toBeDefined();
    expect(screen.getByText("Detail")).toBeDefined();
  });

  it("parses legacy XML text output so old TaskOutput results are visible", () => {
    renderWithProviders(
      <div>
        {taskOutputRenderer.renderInline?.(
          { task_id: "agent-2", block: true },
          `<retrieval_status>success</retrieval_status>
<task_id>agent-2</task_id>
<task_type>local_agent</task_type>
<status>completed</status>
<output>
Visible explore report
</output>` as unknown as TaskOutputResult,
          false,
          "complete",
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText(/success/)).toBeDefined();
    expect(screen.getByText("local_agent")).toBeDefined();
    expect(screen.getByText("Visible explore report")).toBeDefined();
  });
});
