import { afterEach, describe, expect, it } from "vitest";
import {
  displayNodeContainsMessage,
  renderItemContainsMessage,
} from "../messageSearchTarget";
import { buildSessionDisplayRenderItems } from "../sessionDisplay";
import {
  findTextRanges,
  paintSearchHighlights,
} from "../transcriptSearchHighlight";

describe("message search targets", () => {
  it("resolves source message ids to projected display rows", () => {
    const items = buildSessionDisplayRenderItems(
      {
        sessionId: "session",
        revision: "rev",
        turns: [
          {
            id: "turn:u1",
            question: { messageId: "u1", content: "question" },
            segments: [
              {
                type: "process",
                id: "process:question:u1:0",
                status: "completed",
                stepCount: 1,
                toolCount: 0,
                failedToolCount: 0,
                thinkingCount: 0,
                updateCount: 1,
                version: 1,
                messageIds: ["a0"],
              },
              {
                type: "assistant_text",
                id: "text:a1:1",
                messageId: "a1",
                phase: "text",
                content: "answer",
              },
            ],
          },
        ],
      },
      { projectId: "project", formatNotice: () => "" },
    );

    const find = (id: string) =>
      items.find((item) => renderItemContainsMessage(item, id))?.id;
    expect(find("u1")).toBe("u1");
    expect(find("a1")).toBe("text:a1:1");
    expect(find("a0")).toBe("process:question:u1:0");
    expect(find("missing")).toBeUndefined();
  });

  it("matches raw display nodes the same way", () => {
    expect(
      displayNodeContainsMessage(
        {
          type: "segment",
          id: "text:a1:1",
          turnId: "turn:u1",
          segment: {
            type: "assistant_text",
            id: "text:a1:1",
            messageId: "a1",
            phase: "text",
            content: "answer",
          },
        },
        "a1",
      ),
    ).toBe(true);
  });
});

describe("transcript search highlight", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds case-insensitive hits that span inline markup", () => {
    document.body.innerHTML =
      "<div id='root'><p><strong>最终状态</strong>：这台机器</p><p>Needle and NEEDLE</p><textarea>needle</textarea></div>";
    const root = document.getElementById("root") as HTMLElement;

    const spanning = findTextRanges(root, "最终状态：这台");
    expect(spanning).toHaveLength(1);
    expect(spanning[0]?.toString()).toBe("最终状态：这台");

    const ranges = findTextRanges(root, "needle");
    expect(ranges.map((range) => range.toString())).toEqual([
      "Needle",
      "NEEDLE",
    ]);
  });

  it("returns the requested occurrence, clamped to the last hit", () => {
    document.body.innerHTML =
      "<div id='root'><div id='item'>alpha beta alpha</div></div>";
    const root = document.getElementById("root") as HTMLElement;
    const item = document.getElementById("item") as HTMLElement;

    const second = paintSearchHighlights(root, "alpha", {
      element: item,
      occurrence: 1,
    });
    expect(second?.startOffset).toBe(11);
    const clamped = paintSearchHighlights(root, "alpha", {
      element: item,
      occurrence: 9,
    });
    expect(clamped?.startOffset).toBe(11);
    expect(paintSearchHighlights(root, "gamma", null)).toBeNull();
  });
});
