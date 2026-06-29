import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api/client";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../i18n";
import { UI_KEYS } from "../../../lib/storageKeys";
import { TextBlock } from "../TextBlock";

vi.mock("../../../api/client", () => ({
  api: {
    getFile: vi.fn(),
    getFileRawUrl: vi.fn(
      () => "/api/projects/proj-1/files/raw?path=sample.txt",
    ),
  },
}));

function renderWithSessionMetadata(ui: React.ReactNode) {
  return render(
    <I18nProvider>
      <SessionMetadataProvider
        projectId="proj-1"
        projectPath="/Users/yueyuan/project"
        sessionId="session-1"
      >
        {ui}
      </SessionMetadataProvider>
    </I18nProvider>,
  );
}

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

describe("TextBlock", () => {
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens project-local markdown file links in the file viewer", async () => {
    vi.mocked(api.getFile).mockResolvedValue({
      metadata: {
        path: "transcripts/sample.txt",
        size: 20,
        mimeType: "text/plain",
        isText: true,
      },
      content: "corrected transcript",
      rawUrl: "/api/projects/proj-1/files/raw?path=transcripts%2Fsample.txt",
    });

    renderWithSessionMetadata(
      <TextBlock
        text=""
        augmentHtml={
          '<p><a href="/api/local-image?path=%2FUsers%2Fyueyuan%2Fproject%2Ftranscripts%2Fsample.txt">激进版 sample</a></p>'
        }
      />,
    );

    fireEvent.click(screen.getByText("激进版 sample"));

    await waitFor(() => {
      expect(api.getFile).toHaveBeenCalledWith(
        "proj-1",
        "transcripts/sample.txt",
        true,
      );
    });
    expect(await screen.findByText("corrected transcript")).toBeTruthy();
  });

  it("opens project-external local markdown links in the local file modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            metadata: {
              path: "/Users/yueyuan/.codex/AGENTS.md",
              size: 27,
              mimeType: "text/markdown",
              isText: true,
            },
            content: "# Global Agents\n\nUse rg first.",
            rawUrl:
              "/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md",
            lineNumber: 3,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    renderWithSessionMetadata(
      <TextBlock
        text=""
        augmentHtml={
          '<p><a href="/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md&amp;line=3" class="local-file-link" data-file-path="/Users/yueyuan/.codex/AGENTS.md" data-line="3">~/.codex/AGENTS.md</a></p>'
        }
      />,
    );

    fireEvent.click(screen.getByText("~/.codex/AGENTS.md"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md&line=3",
        { credentials: "include" },
      );
    });
    expect(await screen.findByText("Use rg first.")).toBeTruthy();
    expect(api.getFile).not.toHaveBeenCalled();
  });

  it("linkifies plain local image paths and opens the media modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise(() => {
            // Keep the image request pending so the modal remains in loading state.
          }),
      ),
    );

    renderWithSessionMetadata(
      <TextBlock text={"Saved image:\n\n/tmp/kitten.png"} />,
    );

    const link = screen.getByRole("link", { name: /\/tmp\/kitten\.png/i });
    expect(link.getAttribute("href")).toBe(
      "/api/local-image?path=%2Ftmp%2Fkitten.png",
    );
    expect(link.getAttribute("data-media-type")).toBe("image");

    fireEvent.click(link);

    expect(await screen.findByText("Loading...")).toBeTruthy();
  });

  it("copies active text selection instead of the whole block", async () => {
    renderWithSessionMetadata(<TextBlock text="alpha beta gamma" />);

    selectTextInElement(screen.getByText("alpha beta gamma"), "beta");
    fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("beta");
    });
  });
});
