import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashCommandButton } from "../SlashCommandButton";

describe("SlashCommandButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("can insert only the prefix when commands are not preloaded", () => {
    const onSelectCommand = vi.fn();
    const onInsertPrefix = vi.fn();

    render(
      <SlashCommandButton
        commands={[]}
        onSelectCommand={onSelectCommand}
        onInsertPrefix={onInsertPrefix}
        prefix="/"
        label="Slash commands"
      />,
    );

    const button = screen.getByRole("button", {
      name: "Insert slash commands prefix",
    }) as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    expect(onInsertPrefix).toHaveBeenCalledTimes(1);
    expect(onSelectCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
