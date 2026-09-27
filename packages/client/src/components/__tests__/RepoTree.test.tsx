import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoTree } from "../RepoTree";

const mocks = vi.hoisted(() => ({
  browseProjectFiles: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { browseProjectFiles: mocks.browseProjectFiles },
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("RepoTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.browseProjectFiles.mockImplementation(
      (_projectId: string, path: string) =>
        Promise.resolve(
          path === "src"
            ? {
                entries: [
                  { name: "App.tsx", path: "src/App.tsx", type: "file" },
                ],
              }
            : {
                entries: [
                  { name: "src", path: "src", type: "dir" },
                  { name: "README.md", path: "README.md", type: "file" },
                ],
              },
        ),
    );
  });

  it("browses nested project files and delegates files to the workbench", async () => {
    const onOpenFile = vi.fn();
    render(<RepoTree projectId="project-1" onOpenFile={onOpenFile} />);

    const src = await screen.findByRole("button", { name: "src" });
    expect(mocks.browseProjectFiles).toHaveBeenCalledWith("project-1", "");

    fireEvent.click(src);
    const file = await screen.findByRole("button", { name: "App.tsx" });
    expect(mocks.browseProjectFiles).toHaveBeenCalledWith("project-1", "src");

    fireEvent.click(file);
    expect(onOpenFile).toHaveBeenCalledWith("src/App.tsx");
  });
});
