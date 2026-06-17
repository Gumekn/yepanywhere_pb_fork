import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { preprocessMessages } from "../preprocessMessages";
import { preprocessMessagesCached } from "../preprocessMessagesCache";

describe("preprocessMessagesCached", () => {
  it("reuses prefix render items when a streaming tail message is appended", () => {
    const userMessage: Message = {
      id: "msg-user",
      role: "user",
      content: "Hello",
      timestamp: "2024-01-01T00:00:00Z",
    };
    const streamingMessage: Message = {
      id: "msg-stream",
      type: "assistant",
      role: "assistant",
      _isStreaming: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
      timestamp: "2024-01-01T00:00:01Z",
    };

    const first = preprocessMessagesCached([userMessage]);
    const second = preprocessMessagesCached(
      [userMessage, streamingMessage],
      undefined,
      first.cache,
    );

    expect(second.renderItems).toEqual(
      preprocessMessages([userMessage, streamingMessage]),
    );
    expect(second.renderItems[0]).toBe(first.renderItems[0]);
  });

  it("reuses prefix render items when a streaming tail message is replaced", () => {
    const userMessage: Message = {
      id: "msg-user",
      role: "user",
      content: "Hello",
      timestamp: "2024-01-01T00:00:00Z",
    };
    const firstStreamingMessage: Message = {
      id: "msg-stream",
      type: "assistant",
      role: "assistant",
      _isStreaming: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hel" }],
      },
      timestamp: "2024-01-01T00:00:01Z",
    };
    const nextStreamingMessage: Message = {
      ...firstStreamingMessage,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    };

    const first = preprocessMessagesCached([
      userMessage,
      firstStreamingMessage,
    ]);
    const second = preprocessMessagesCached(
      [userMessage, nextStreamingMessage],
      undefined,
      first.cache,
    );

    expect(second.renderItems).toEqual(
      preprocessMessages([userMessage, nextStreamingMessage]),
    );
    expect(second.renderItems[0]).toBe(first.renderItems[0]);
    expect(second.renderItems.at(-1)).toMatchObject({
      type: "text",
      text: "Hello",
    });
  });

  it("falls back to full preprocessing when augments change", () => {
    const message: Message = {
      id: "msg-1",
      type: "assistant",
      role: "assistant",
      content: "Hello **world**",
      timestamp: "2024-01-01T00:00:00Z",
    };

    const first = preprocessMessagesCached([message]);
    const second = preprocessMessagesCached(
      [message],
      {
        markdown: {
          "msg-1": { html: "<p>Hello <strong>world</strong></p>" },
        },
      },
      first.cache,
    );

    expect(second.renderItems).toEqual(
      preprocessMessages([message], {
        markdown: {
          "msg-1": { html: "<p>Hello <strong>world</strong></p>" },
        },
      }),
    );
    expect(second.renderItems[0]).not.toBe(first.renderItems[0]);
  });
});
