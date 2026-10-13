import type { ClaudeSessionEntry } from "../claude-sdk-schema/types.js";
import type { CodexSessionEntry } from "../codex-schema/index.js";
import type { GeminiSessionFile } from "../gemini-schema/session.js";
import type { KimiSessionContent } from "../kimi-schema/types.js";
import type { PiSessionContent } from "../pi-schema/session.js";
import type { ZCodeSessionContent } from "../zcode-schema/session.js";

/**
 * Claude session file content - array of JSONL entries.
 * Uses the Zod-validated ClaudeSessionEntry type.
 */
export interface ClaudeSessionFile {
  messages: ClaudeSessionEntry[];
}

// Codex sessions are a series of entries (lines)
export interface CodexSessionContent {
  entries: CodexSessionEntry[];
}

/** One visible turn recovered from a Cursor ACP `store.db` blob. */
export interface CursorTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  reasoning?: string;
  /** Ordered visible content, including native tool calls and results. */
  blocks?: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
    | {
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }
  >;
}

export interface CursorSessionContent {
  messages: CursorTranscriptMessage[];
}

export type UnifiedSession =
  | { provider: "claude"; session: ClaudeSessionFile }
  | { provider: "claude-ollama"; session: ClaudeSessionFile }
  | { provider: "codex"; session: CodexSessionContent }
  | { provider: "codex-oss"; session: CodexSessionContent }
  | { provider: "gemini"; session: GeminiSessionFile }
  | { provider: "pi"; session: PiSessionContent }
  | { provider: "kimi"; session: KimiSessionContent }
  | { provider: "zcode"; session: ZCodeSessionContent }
  | { provider: "cursor"; session: CursorSessionContent };
