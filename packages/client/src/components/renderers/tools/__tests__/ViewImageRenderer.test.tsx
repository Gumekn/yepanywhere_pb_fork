import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { viewImageRenderer } from "../ViewImageRenderer";

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("ViewImageRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses the saved image filename instead of the generic generated title", () => {
    const input = {
      title: "Generated image",
      path: "/Users/test/.codex/generated_images/session-1/ig_123.png",
      status: "completed",
    };

    expect(viewImageRenderer.getUseSummary?.(input)).toBe("ig_123.png");

    render(
      <div>
        {viewImageRenderer.renderInteractiveSummary?.(
          input,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("button", { name: /ig_123\.png/i })).toBeDefined();
    expect(screen.queryByText("Generated image")).toBeNull();
  });

  it("uses the URL filename when the image source is remote", () => {
    expect(
      viewImageRenderer.getUseSummary?.({
        title: "Generated image",
        url: "https://example.test/assets/preview-final.webp",
      }),
    ).toBe("preview-final.webp");
  });

  it("shows image dimensions after the modal image loads", async () => {
    const input = {
      url: "https://example.test/assets/preview-final.webp",
    };

    render(
      <I18nProvider>
        {viewImageRenderer.renderToolResult?.({}, false, renderContext, input)}
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /preview-final\.webp/i }),
    );

    const image = await screen.findByRole("img", {
      name: /preview-final\.webp/i,
    });
    Object.defineProperty(image, "naturalWidth", {
      value: 640,
      configurable: true,
    });
    Object.defineProperty(image, "naturalHeight", {
      value: 480,
      configurable: true,
    });

    fireEvent.load(image);

    expect(screen.getByText("Dimensions 640x480")).toBeDefined();
  });
});
