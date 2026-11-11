import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SessionDisplayNode } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api/client";
import { I18nProvider } from "../../../i18n";
import type { DisplayProcessItem } from "../../../types/renderItems";
import { RenderItemComponent } from "../../RenderItemComponent";
import { resetDisplayProcessStateForTests } from "../DisplayProcessRow";

function item(
  overrides: Partial<DisplayProcessItem["process"]> = {},
): DisplayProcessItem {
  return {
    type: "display_process",
    id: "process:question:q:0",
    projectId: "project-1",
    sessionId: "session-1",
    revision: "display-v2:epoch",
    process: {
      type: "process",
      id: "process:question:q:0",
      status: "completed",
      stepCount: 2,
      toolCount: 3,
      failedToolCount: 1,
      thinkingCount: 0,
      updateCount: 1,
      startedAt: "2026-01-02T10:00:00Z",
      endedAt: "2026-01-02T10:01:08Z",
      version: 7,
      ...overrides,
    },
    sourceMessages: [],
  };
}

const members: SessionDisplayNode[] = [
  {
    type: "segment",
    id: "text:progress",
    turnId: "turn:t",
    segment: {
      type: "assistant_text",
      id: "text:progress",
      phase: "progress",
      content: "Checking the config first",
    },
  },
  {
    type: "segment",
    id: "dg2.group",
    turnId: "turn:t",
    segment: {
      type: "tool_group",
      id: "dg2.group",
      detailRef: "dg2.group",
      status: "mixed",
      count: 3,
      failedCount: 1,
      toolNames: [],
      displayMode: "summary",
    },
  },
];

function renderProcess(process: DisplayProcessItem) {
  return render(
    <I18nProvider>
      <RenderItemComponent
        item={process}
        isStreaming={false}
        thinkingExpanded={false}
        toggleThinkingExpanded={() => {}}
        sessionProvider="codex"
      />
    </I18nProvider>,
  );
}

describe("DisplayProcessRow", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetDisplayProcessStateForTests();
  });

  it("shows only the summary until the reader opens the fold", async () => {
    const getProcess = vi
      .spyOn(api, "getSessionDisplayProcess")
      .mockResolvedValue({ processId: item().id, nodes: members });
    renderProcess(item());

    const header = screen.getByRole("button", { expanded: false });
    expect(header.textContent).toContain("Completed in 1m 8s");
    expect(header.textContent).toContain("3 tool calls");
    expect(header.textContent).toContain("1 failed");
    expect(screen.queryByText("Checking the config first")).toBeNull();
    expect(getProcess).not.toHaveBeenCalled();

    fireEvent.click(header);
    await screen.findByText("Checking the config first");
    expect(getProcess).toHaveBeenCalledWith(
      "project-1",
      "session-1",
      "process:question:q:0",
      expect.objectContaining({ cursor: undefined }),
    );
    expect(screen.getByTestId("projected-tool-group")).toBeTruthy();

    // Collapsing and re-opening the same version reuses the loaded members.
    fireEvent.click(
      screen.getByRole("button", { expanded: true, name: /1m 8s/ }),
    );
    expect(screen.queryByText("Checking the config first")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { expanded: false, name: /1m 8s/ }),
    );
    expect(screen.getByText("Checking the config first")).toBeTruthy();
    expect(getProcess).toHaveBeenCalledTimes(1);
  });

  it("passes the older-page cursor and offers a retry when loading fails", async () => {
    const getProcess = vi
      .spyOn(api, "getSessionDisplayProcess")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ processId: item().id, nodes: members });
    renderProcess(
      item({ status: "interrupted", endedAt: undefined, pageCursor: "older" }),
    );
    const header = screen.getByRole("button", { expanded: false });
    expect(header.textContent).toContain("Interrupted");
    fireEvent.click(header);

    const retry = await screen.findByRole("button", {
      name: /Could not load work steps/,
    });
    expect(getProcess).toHaveBeenLastCalledWith(
      "project-1",
      "session-1",
      "process:question:q:0",
      expect.objectContaining({ cursor: "older" }),
    );
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByText("Checking the config first")).toBeTruthy(),
    );
  });
});
