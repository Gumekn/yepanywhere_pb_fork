import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { ThinkingBlock } from "../blocks/ThinkingBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps an in-flight detail request when streaming snapshots recreate the same reference", async () => {
  let complete!: (
    value: Awaited<ReturnType<typeof api.getSessionThinkingDetail>>,
  ) => void;
  const request = vi.spyOn(api, "getSessionThinkingDetail").mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const element = (thinking: string) => (
    <I18nProvider>
      <ThinkingBlock
        thinking={thinking}
        status="streaming"
        isExpanded
        onToggle={() => {}}
        detail={{
          projectId: "p",
          sessionId: "s",
          revision: "epoch",
          detailRef: "thinking:live:0",
          truncated: true,
        }}
      />
    </I18nProvider>
  );
  const view = render(element("First preview"));
  view.rerender(element("Updated preview"));
  await act(async () => {
    complete({
      sessionId: "s",
      revision: "epoch",
      detailRef: "thinking:live:0",
      content: "Complete reasoning body",
    });
  });
  expect(screen.getByText("Complete reasoning body")).toBeTruthy();
  expect(request).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).toBeNull();
});
