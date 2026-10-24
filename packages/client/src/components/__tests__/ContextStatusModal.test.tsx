import { cleanup, render, screen } from "@testing-library/react";
import type { ContextStatusResponse } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { ContextStatusModal } from "../ContextStatusModal";

vi.mock("../../api/client", () => ({ api: { getContextStatus: vi.fn() } }));

const snapshot: ContextStatusResponse = {
  source: "native",
  contextUsage: {
    inputTokens: 196_533,
    contextWindow: 256_000,
    percentage: 76.8,
    categories: [
      { id: "system_prompt", name: "System prompt", tokens: 2111 },
      { id: "conversation", name: "Conversation", tokens: 194_422 },
      { id: "future_category", name: "Future category", tokens: 0 },
    ],
  },
};

function renderModal(data: ContextStatusResponse) {
  vi.mocked(api.getContextStatus).mockResolvedValue(data);
  return render(
    <I18nProvider>
      <ContextStatusModal
        projectId="project"
        sessionId="session"
        onClose={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("Cursor context details", () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem(UI_KEYS.locale);
    vi.clearAllMocks();
  });

  it.each([
    ["en", "Native session snapshot", "System prompt", "Conversation"],
    ["zh-CN", "原生会话快照", "系统提示词", "对话"],
  ])(
    "shows native counts and translated categories in %s",
    async (locale, source, system, conversation) => {
      localStorage.setItem(UI_KEYS.locale, locale);
      renderModal(snapshot);
      expect(await screen.findByText(source)).toBeTruthy();
      expect(await screen.findByText(system)).toBeTruthy();
      expect(screen.getByText(conversation)).toBeTruthy();
      expect(screen.getByText("Future category")).toBeTruthy();
      expect(screen.getByText("76.8%")).toBeTruthy();
      expect(screen.getByText("196.5K / 256.0K")).toBeTruthy();
      expect(screen.queryByText("Estimate (JSONL)")).toBeNull();
    },
  );

  it("shows missing native statistics without fabricating a zero meter", async () => {
    renderModal({ source: "native" });
    expect(
      await screen.findByText(
        "Cursor CLI has not saved context usage for this session yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("keeps native totals visible when the CLI has no category breakdown", async () => {
    renderModal({
      source: "native",
      contextUsage: {
        inputTokens: 20_000,
        contextWindow: 256_000,
        percentage: 7.8,
      },
    });
    expect(await screen.findByText("20.0K / 256.0K")).toBeTruthy();
    expect(screen.queryByText("Categories")).toBeNull();
  });

  it("shows overflow percentages while clamping only the visual meter", async () => {
    renderModal({
      source: "native",
      contextUsage: {
        inputTokens: 260_000,
        contextWindow: 256_000,
        percentage: 101.6,
      },
    });
    expect(await screen.findByText("101.6%")).toBeTruthy();
    expect(screen.getByText("260.0K / 256.0K")).toBeTruthy();
    expect(
      document.querySelector<HTMLElement>(".context-status-hero-bar-fill")
        ?.style.width,
    ).toBe("100%");
  });
});
