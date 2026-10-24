import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import { ToolGroupDuration } from "../ToolGroupDuration";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderDuration(timedCount?: number, durationMs?: number) {
  return render(
    <I18nProvider>
      <ToolGroupDuration
        group={{
          type: "tool_group",
          id: "group",
          detailRef: "group",
          count: 4,
          failedCount: 0,
          status: "completed",
          toolNames: [],
          timedCount,
          durationMs,
        }}
      />
    </I18nProvider>,
  );
}

describe("ToolGroupDuration", () => {
  it("labels the total and explains that concurrent calls count separately", () => {
    renderDuration(4, 12500);
    expect(screen.getByText("Total tool time 12s")).toBeDefined();
    expect(screen.getByTestId("tool-group-duration").title).toContain("4/4");
    expect(screen.getByTestId("tool-group-duration").title).toContain(
      "parallel calls count separately",
    );
  });

  it("labels partial coverage instead of presenting it as the full total", () => {
    renderDuration(2, 72000);
    expect(screen.getByText("Known tool time 1m12s")).toBeDefined();
    expect(screen.getByTestId("tool-group-duration").title).toContain("2/4");
  });

  it("shows unavailable time explicitly", () => {
    renderDuration();
    expect(screen.getByText("Time unavailable")).toBeDefined();
  });

  it("keeps native zero duration visible", () => {
    renderDuration(4, 0);
    expect(screen.getByText("Total tool time <1s")).toBeDefined();
  });

  it("renders the Chinese group label", async () => {
    localStorage.setItem("yep-anywhere-locale", "zh-CN");
    renderDuration(4, 12500);
    expect(await screen.findByText("累计耗时 12s")).toBeDefined();
  });
});
