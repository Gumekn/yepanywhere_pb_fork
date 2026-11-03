import type { SideConversationSnapshot } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { preprocessMessages } from "../preprocessMessages";
import { sideConversationToMessages } from "../sideConversationMessages";
import { parseUserPromptContent } from "../userPromptContent";

function snapshot(
  overrides: Partial<SideConversationSnapshot>,
): SideConversationSnapshot {
  return {
    id: "side",
    parentSessionId: "main",
    capturedAt: "2026-10-10T00:00:00Z",
    context: "snapshot",
    status: "idle",
    version: 1,
    messages: [],
    ...overrides,
  };
}

describe("sideConversationToMessages", () => {
  it("pairs tool results with their calls through the shared preprocessor", () => {
    const items = preprocessMessages(
      sideConversationToMessages(
        snapshot({
          messages: [
            { id: "q", role: "user", text: "why?" },
            {
              id: "a",
              role: "assistant",
              text: "Done",
              blocks: [
                { type: "thinking", thinking: "look" },
                {
                  type: "tool_use",
                  id: "call",
                  name: "Grep",
                  input: { pattern: "x" },
                  result: { content: "hit", isError: true },
                },
                { type: "text", text: "Done", html: "<p>Done</p>" },
              ],
            },
          ],
        }),
      ),
    );
    expect(items.map((item) => item.type)).toEqual([
      "user_prompt",
      "thinking",
      "tool_call",
      "text",
    ]);
    const tool = items[2];
    expect(tool?.type === "tool_call" && tool.status).toBe("error");
    expect(tool?.type === "tool_call" && tool.toolResult?.content).toBe("hit");
    const text = items[3];
    expect(text?.type === "text" && text.augmentHtml).toBe("<p>Done</p>");
  });

  it("marks unanswered calls interrupted only after the turn ends", () => {
    const messages = [
      {
        id: "a",
        role: "assistant" as const,
        text: "",
        blocks: [
          { type: "tool_use" as const, id: "call", name: "Read", input: {} },
        ],
      },
    ];
    const status = (state: SideConversationSnapshot["status"]) => {
      const item = preprocessMessages(
        sideConversationToMessages(snapshot({ status: state, messages })),
      )[0];
      return item?.type === "tool_call" ? item.status : undefined;
    };
    expect(status("running")).toBe("pending");
    expect(status("idle")).toBe("aborted");
  });

  it("falls back to prose from older servers and skips empty steps", () => {
    const messages = sideConversationToMessages(
      snapshot({
        messages: [
          { id: "empty", role: "assistant", text: "" },
          { id: "old", role: "assistant", text: "Legacy", html: "<p>L</p>" },
        ],
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message?.content).toEqual([
      { type: "text", text: "Legacy", _html: "<p>L</p>" },
    ]);
  });

  it("shows attached images as prompt attachments without exposing paths", () => {
    const [prompt] = sideConversationToMessages(
      snapshot({
        messages: [
          {
            id: "q",
            role: "user",
            text: "@[shot.png] what is this?",
            attachments: [{ name: "shot.png", mimeType: "image/png" }],
          },
        ],
      }),
    );
    expect(prompt?.message?.content).toContain(
      "User uploaded files:\n- shot.png (—, image/png): shot.png",
    );
    const parsed = parseUserPromptContent(prompt?.message?.content as string);
    expect(parsed.text).toBe("@[shot.png] what is this?");
    expect(parsed.uploadedFiles).toMatchObject([
      { originalName: "shot.png", mimeType: "image/png" },
    ]);
  });
});
