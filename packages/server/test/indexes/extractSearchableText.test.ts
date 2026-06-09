import { describe, expect, it } from "vitest";
import {
  MAX_CHARS_PER_MESSAGE,
  buildSnippet,
  extractSearchableMessages,
} from "../../src/indexes/extractSearchableText.js";
import type { Message } from "../../src/supervisor/types.js";

function userMessage(uuid: string, content: unknown): Message {
  return {
    type: "user",
    uuid,
    message: { role: "user", content: content as never },
  } as Message;
}

function assistantMessage(uuid: string, blocks: unknown[]): Message {
  return {
    type: "assistant",
    uuid,
    message: { role: "assistant", content: blocks as never },
  } as Message;
}

describe("extractSearchableMessages", () => {
  it("extracts plain string user content", () => {
    const result = extractSearchableMessages([
      userMessage("u1", "Hello there world"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("u1");
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.originalText).toBe("Hello there world");
    expect(result[0]?.text).toBe("hello there world");
  });

  it("extracts only text blocks from assistant content, skipping tool/thinking", () => {
    const result = extractSearchableMessages([
      assistantMessage("a1", [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "Visible answer" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "More answer" },
      ]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.originalText).toBe("Visible answer\nMore answer");
    expect(result[0]?.originalText).not.toContain("secret reasoning");
    expect(result[0]?.originalText).not.toContain("ls");
  });

  it("skips non-user/assistant messages", () => {
    const result = extractSearchableMessages([
      { type: "system", uuid: "s1", message: { content: "boot" } } as Message,
      userMessage("u1", "real content"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("u1");
  });

  it("skips messages with no searchable text", () => {
    const result = extractSearchableMessages([
      assistantMessage("a1", [
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ]),
      userMessage("u1", "   "),
    ]);
    expect(result).toHaveLength(0);
  });

  it("skips messages without an id", () => {
    const result = extractSearchableMessages([userMessage("", "no id")]);
    expect(result).toHaveLength(0);
  });

  it("caps text at MAX_CHARS_PER_MESSAGE", () => {
    const long = "x".repeat(MAX_CHARS_PER_MESSAGE + 500);
    const result = extractSearchableMessages([userMessage("u1", long)]);
    expect(result[0]?.originalText.length).toBe(MAX_CHARS_PER_MESSAGE);
    expect(result[0]?.text.length).toBe(MAX_CHARS_PER_MESSAGE);
  });
});

describe("buildSnippet", () => {
  it("returns null when query is not present", () => {
    expect(buildSnippet("hello world", "missing")).toBeNull();
  });

  it("centers the snippet on the match with offsets for highlighting", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const snippet = buildSnippet(text, "fox", 20);
    expect(snippet).not.toBeNull();
    if (!snippet) return;
    const { snippet: s, matchStart, matchLength } = snippet;
    expect(matchLength).toBe(3);
    expect(s.slice(matchStart, matchStart + matchLength).toLowerCase()).toBe(
      "fox",
    );
  });

  it("does not add a leading ellipsis when match is at the start", () => {
    const snippet = buildSnippet("fox at the start here", "fox", 30);
    expect(snippet?.snippet.startsWith("…")).toBe(false);
    expect(snippet?.matchStart).toBe(0);
  });

  it("matches case-insensitively but preserves original case in the snippet", () => {
    const snippet = buildSnippet("Hello WORLD", "world", 40);
    expect(snippet).not.toBeNull();
    if (!snippet) return;
    expect(
      snippet.snippet.slice(
        snippet.matchStart,
        snippet.matchStart + snippet.matchLength,
      ),
    ).toBe("WORLD");
  });
});
