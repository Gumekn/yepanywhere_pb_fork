import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRenderer } from "../WriteRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

if (!writeRenderer.renderCollapsedPreview) {
  throw new Error("Write renderer must provide collapsed preview");
}

describe("WriteRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders malformed historical Write input errors without crashing", () => {
    render(
      <div>
        {writeRenderer.renderCollapsedPreview?.(
          {
            __unparsedToolInput: {
              raw: '{"file_path": "/tmp/theme.css"',
              len: 29,
            },
          } as never,
          "InputValidationError: JSON parse failed (29 bytes)" as never,
          true,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText(/JSON parse failed/)).toBeDefined();
  });
});
