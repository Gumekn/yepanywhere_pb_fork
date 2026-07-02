import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Message, ProviderName } from "../../types";
import { SessionInspector } from "../SessionInspector";

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: () => ({
    gitStatus: { isGitRepo: true, isClean: true, files: [] },
    loading: false,
    error: null,
  }),
}));

function renderInspector(provider: ProviderName, messages: Message[]) {
  window.localStorage.setItem(UI_KEYS.locale, "en");
  return render(
    <MemoryRouter>
      <I18nProvider>
        <SessionInspector
          presentation="sidebar"
          messages={messages}
          projectId="project-1"
          sessionId="session-1"
          provider={provider}
          status={{ owner: "none" }}
          onSelectMessage={vi.fn()}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SessionInspector", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.locale);
  });

  it("shows Codex channel metadata for Codex sessions", () => {
    renderInspector("codex", [
      {
        uuid: "msg-1",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I am checking the repo." }],
        },
      },
      {
        uuid: "msg-2",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still checking." }],
        },
      },
      {
        uuid: "msg-3",
        type: "assistant",
        codexMessagePhase: "final_answer",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]);

    expect(screen.getByLabelText("Channels")).not.toBeNull();
    expect(screen.getByText("Commentary")).not.toBeNull();
    expect(screen.getByText("Final")).not.toBeNull();
    expect(screen.getByText("2 messages")).not.toBeNull();
    expect(screen.getByText("1 messages")).not.toBeNull();
    expect(screen.queryByText("I am checking the repo.")).toBeNull();
    expect(screen.queryByText("Done.")).toBeNull();
  });

  it("does not show Codex channel metadata for Claude sessions", () => {
    renderInspector("claude", [
      {
        uuid: "msg-1",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude text" }],
        },
      },
    ]);

    expect(screen.queryByLabelText("Channels")).toBeNull();
    expect(screen.queryByText("Commentary")).toBeNull();
  });
});
