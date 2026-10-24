import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { useSideConversation } from "../../hooks/useSideConversation";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { SideConversationPanel } from "../SideConversationPanel";

vi.mock("../blocks/TextBlock", () => ({
  TextBlock: ({ text }: { text: string }) => <p>{text}</p>,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function fixture(
  overrides: Partial<ReturnType<typeof useSideConversation>> = {},
) {
  localStorage.setItem(UI_KEYS.locale, "en");
  const side: ReturnType<typeof useSideConversation> = {
    supported: true,
    availability: "ready",
    error: undefined,
    busy: false,
    conversation: {
      id: "side",
      parentSessionId: "main",
      capturedAt: "2026-10-10T00:00:00Z",
      context: "snapshot",
      status: "idle",
      version: 1,
      messages: [{ id: "a", role: "assistant", text: "A side answer" }],
    },
    send: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    startNew: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    ...overrides,
  };
  const onClose = vi.fn();
  const onBringBack = vi.fn();
  const view = render(
    <I18nProvider>
      <SideConversationPanel
        side={side}
        sessionId="main"
        parentStatus="Running"
        visible
        mobile
        onClose={onClose}
        onBringBack={onBringBack}
      />
    </I18nProvider>,
  );
  return { side, view, onClose, onBringBack };
}

it("keeps return/hide separate from stop and makes handoff a draft-only action", () => {
  const { side, onClose, onBringBack } = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Back to main task" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(side.interrupt).not.toHaveBeenCalled();
  expect(side.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Bring to main input" }));
  expect(onBringBack).toHaveBeenCalledWith("A side answer");
  expect(side.send).not.toHaveBeenCalled();
});

it("preserves the question after failure and never submits while composing with IME", async () => {
  const { side } = fixture();
  vi.mocked(side.send).mockResolvedValue(false);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "side question" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(side.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect((input as HTMLTextAreaElement).value).toBe("side question"),
  );
  expect(side.send).toHaveBeenCalledWith("side question", "snapshot");
});

it("keeps a writable independent draft when the runtime has no side endpoint", () => {
  const { side } = fixture({
    supported: false,
    availability: "unsupported",
    conversation: undefined,
  });
  expect(screen.getByRole("status").textContent).toContain(
    "server needs an update",
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "parallel question" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("parallel question");
  expect(side.send).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
