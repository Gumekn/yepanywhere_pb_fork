import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { MessageInput } from "../MessageInput";

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: { current: "test", capabilities: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
    refetchFresh: vi.fn(),
  }),
}));

function renderMessageInput(
  props: Partial<React.ComponentProps<typeof MessageInput>> = {},
) {
  const onSend = vi.fn();

  render(
    <I18nProvider>
      <MessageInput
        onSend={onSend}
        draftKey={`message-input-test-${crypto.randomUUID()}`}
        supportsPermissionMode={false}
        supportsThinkingToggle={false}
        {...props}
      />
    </I18nProvider>,
  );

  return {
    onSend,
    textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
  };
}

function typeInTextarea(textarea: HTMLTextAreaElement, value: string) {
  textarea.focus();
  fireEvent.change(textarea, { target: { value } });
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.keyUp(textarea);
}

describe("MessageInput command completion", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(pointer: coarse)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows and inserts Claude slash commands only for '/' tokens", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["deep-research", "model"],
    });

    typeInTextarea(textarea, "/de");

    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(
      within(listbox).getByRole("option", { name: "/deep-research" }),
    ).toBeDefined();

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/deep-research ");

    typeInTextarea(textarea, "$mo");
    expect(
      screen.queryByRole("listbox", { name: "Slash commands" }),
    ).toBeNull();
  });

  it("shows and inserts Codex dollar commands only for '$' tokens", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Codex commands",
      commands: ["model", "review"],
    });

    typeInTextarea(textarea, "$mo");

    const listbox = screen.getByRole("listbox", { name: "Codex commands" });
    expect(
      within(listbox).getByRole("option", { name: "$model" }),
    ).toBeDefined();

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("$model ");

    typeInTextarea(textarea, "/mo");
    expect(
      screen.queryByRole("listbox", { name: "Codex commands" }),
    ).toBeNull();
  });

  it("uses the active provider prefix in the toolbar command menu", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Codex commands",
      commands: ["model", "review"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show codex commands" }),
    );

    const menu = screen.getByRole("menu", { name: "Codex commands" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "$model" }));

    expect(textarea.value).toBe("$model ");
  });

  it("renders static dollar and slash command toolbar buttons", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Codex commands",
      commands: ["model"],
      commandButtons: [
        {
          prefix: "$",
          label: "Codex commands",
          showButton: true,
          commands: ["model"],
        },
        {
          prefix: "/",
          label: "Slash commands",
          showButton: true,
          commands: ["help"],
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show slash commands" }),
    );
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Slash commands" })).getByRole(
        "menuitem",
        { name: "/help" },
      ),
    );

    expect(textarea.value).toBe("/help ");
  });

  it("keeps the toolbar command button stable while commands are loading", () => {
    renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: [],
      showCommandButton: true,
    });

    const button = screen.getByRole("button", {
      name: "Show slash commands",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(screen.queryByRole("menu", { name: "Slash commands" })).toBeNull();
  });

  it("does not show the toolbar command button when provider flags disable it", () => {
    renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: [],
      showCommandButton: false,
    });

    expect(
      screen.queryByRole("button", { name: "Show slash commands" }),
    ).toBeNull();
  });

  it("keeps custom slash commands from handling Codex dollar commands", () => {
    const onCustomCommand = vi.fn(() => true);
    const { textarea } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Codex commands",
      commands: ["model"],
      onCustomCommand,
    });

    typeInTextarea(textarea, "$mo");
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(onCustomCommand).not.toHaveBeenCalled();
    expect(textarea.value).toBe("$model ");
  });

  it("still routes custom slash commands through the slash handler", () => {
    const onCustomCommand = vi.fn(() => true);
    const { textarea } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["model"],
      onCustomCommand,
    });

    typeInTextarea(textarea, "/mo");
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(onCustomCommand).toHaveBeenCalledWith("model");
    expect(textarea.value).toBe("");
  });

  it("submits an exact slash command instead of forcing completion", () => {
    const { textarea, onSend } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["deep-research"],
    });

    typeInTextarea(textarea, "/deep-research");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/deep-research");
    expect(textarea.value).toBe("");
  });
});
