/**
 * Cheap searchable-text extraction for the content search index.
 *
 * Rather than re-implementing per-provider JSONL parsing, we extract text from
 * the *normalized* `Message[]` that every provider's reader already produces via
 * `normalizeSession()`. This keeps a single extraction path, guarantees the
 * emitted `messageId` matches what the client renders (`uuid ?? id`), and only
 * runs on cache miss (a session file actually changed).
 *
 * We deliberately index only user/assistant *natural language* text:
 *   - user text blocks
 *   - assistant text blocks
 * and skip `thinking`, `tool_use` input, and `tool_result` content (large,
 * low-value blobs that would bloat the index).
 */

import type { ContentBlock, Message } from "../supervisor/types.js";

/** Hard cap on indexed text per message to bound index size. */
export const MAX_CHARS_PER_MESSAGE = 2000;

/** Default snippet window (chars of context around a match). */
export const DEFAULT_SNIPPET_WINDOW = 150;

/**
 * One indexed message: the minimum needed to (a) match a query,
 * (b) build a snippet, and (c) deep-link the client to the message.
 */
export interface IndexedMessage {
  /** Stable id matching the client's getMessageId (uuid ?? id). */
  id: string;
  /** "user" | "assistant" (best-effort role). */
  role: string;
  /** Lowercased text, used for matching. Capped at MAX_CHARS_PER_MESSAGE. */
  text: string;
  /** Original-case text, used for snippet display. Same length as `text`. */
  originalText: string;
}

/** A single match within a message, with offsets for client highlighting. */
export interface TextMatch {
  /** Snippet of surrounding context with the match inside it. */
  snippet: string;
  /** Char offset of the match start *within the snippet*. */
  matchStart: number;
  /** Char length of the matched substring. */
  matchLength: number;
}

/** Resolve the canonical message id the same way the client does. */
function messageId(message: Message): string {
  const uuid = typeof message.uuid === "string" ? message.uuid : undefined;
  const id =
    typeof message.id === "string" ? (message.id as string) : undefined;
  return uuid ?? id ?? "";
}

/** Resolve a best-effort role string for display. */
function messageRole(message: Message): string {
  const nestedRole = message.message?.role;
  if (typeof nestedRole === "string" && nestedRole.length > 0) {
    return nestedRole;
  }
  if (typeof message.role === "string" && message.role.length > 0) {
    return message.role as string;
  }
  return message.type === "assistant" ? "assistant" : "user";
}

/**
 * Pull the natural-language text out of a normalized message's content.
 * Concatenates user/assistant text blocks; ignores thinking/tool blocks.
 */
function extractMessageText(message: Message): string {
  const content = message.message?.content ?? message.content;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    // Only index plain text blocks. Skip thinking/tool_use/tool_result.
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract indexed messages from a normalized session's `Message[]`.
 * Only user/assistant messages with non-empty text are kept.
 */
export function extractSearchableMessages(
  messages: Message[],
): IndexedMessage[] {
  const result: IndexedMessage[] = [];

  for (const message of messages) {
    if (message.type !== "user" && message.type !== "assistant") {
      continue;
    }

    const raw = extractMessageText(message).trim();
    if (!raw) continue;

    const id = messageId(message);
    if (!id) continue;

    const originalText =
      raw.length > MAX_CHARS_PER_MESSAGE
        ? raw.slice(0, MAX_CHARS_PER_MESSAGE)
        : raw;

    result.push({
      id,
      role: messageRole(message),
      text: originalText.toLowerCase(),
      originalText,
    });
  }

  return result;
}

/**
 * Build a snippet centered on the first occurrence of `queryLower` within
 * `originalText`. Returns null if no match. `queryLower` must be lowercased.
 */
export function buildSnippet(
  originalText: string,
  queryLower: string,
  windowSize: number = DEFAULT_SNIPPET_WINDOW,
): TextMatch | null {
  if (!queryLower) return null;
  const haystack = originalText.toLowerCase();
  const matchIndex = haystack.indexOf(queryLower);
  if (matchIndex === -1) return null;

  const matchLength = queryLower.length;
  const half = Math.max(0, Math.floor((windowSize - matchLength) / 2));

  let start = matchIndex - half;
  let end = matchIndex + matchLength + half;

  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (end > originalText.length) {
    start = Math.max(0, start - (end - originalText.length));
    end = originalText.length;
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < originalText.length ? "…" : "";
  const core = originalText.slice(start, end);

  return {
    snippet: `${prefix}${core}${suffix}`,
    // Offset within the returned snippet (account for the leading ellipsis).
    matchStart: prefix.length + (matchIndex - start),
    matchLength,
  };
}
