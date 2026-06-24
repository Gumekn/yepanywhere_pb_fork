import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { MessageActions } from "../MessageActions";

function selectTextInElement(element: HTMLElement, selectedText: string): void {
  const textNode = Array.from(element.childNodes).find(
    (node) => node.nodeType === Node.TEXT_NODE,
  );
  if (!textNode) throw new Error("No text node found");

  const text = textNode.textContent ?? "";
  const start = text.indexOf(selectedText);
  if (start === -1) throw new Error(`Text not found: ${selectedText}`);

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + selectedText.length);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderWithI18n(ui: ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("MessageActions", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    vi.clearAllMocks();
  });

  it("copies active text selection instead of the whole message", async () => {
    renderWithI18n(
      <div className="assistant-turn">
        <p>alpha beta gamma</p>
        <MessageActions copyText="alpha beta gamma" />
      </div>,
    );

    selectTextInElement(screen.getByText("alpha beta gamma"), "beta");
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("beta");
    });
  });
});
