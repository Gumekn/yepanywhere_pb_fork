/**
 * Render a normalized session as plain Markdown.
 *
 * The audience is another agent (or a human reading raw text), so the output
 * favors a stable, linear shape over fidelity: one heading per turn, tool calls
 * folded under the assistant turn that issued them with their results, and
 * long tool output truncated by default.
 */

export interface TranscriptSessionHeader {
  title?: string | null;
  provider?: string;
  model?: string;
  projectName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TranscriptMarkdownOptions {
  /** Include assistant thinking blocks. Default false. */
  includeThinking?: boolean;
  /** Per-tool-result character cap; 0 disables truncation. Default 4000. */
  toolOutputLimit?: number;
  /** Extra `- Key: value` rows appended to the header (e.g. snapshot time). */
  extraHeaderRows?: Array<[string, string | undefined | null]>;
}

export const DEFAULT_TRANSCRIPT_TOOL_OUTPUT_LIMIT = 4000;
/** Tool inputs are rarely huge, but a Write of a whole file can be. */
const TOOL_INPUT_LIMIT = 4000;

type Block = Record<string, unknown> & { type?: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocks(message: Record<string, unknown>): Block[] | string {
  const inner = asRecord(message.message);
  const content = inner?.content ?? message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((block): block is Block => asRecord(block) !== null);
  }
  return [];
}

/** Fence that cannot be closed early by backticks inside `text`. */
function fence(text: string, info = ""): string {
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n… [${omitted} more characters truncated]`;
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyInput(content);
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    } else {
      parts.push(stringifyInput(block));
    }
  }
  return parts.join("\n");
}

function formatTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function headerRow(label: string, value: string | null | undefined): string {
  return value ? `- ${label}: ${value}` : "";
}

export function renderTranscriptMarkdown(
  header: TranscriptSessionHeader,
  messages: unknown[],
  options: TranscriptMarkdownOptions = {},
): string {
  const includeThinking = options.includeThinking ?? false;
  const toolOutputLimit =
    options.toolOutputLimit ?? DEFAULT_TRANSCRIPT_TOOL_OUTPUT_LIMIT;

  // Results arrive in a later user message; index them so each one can be
  // printed directly under the call that produced it.
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message || message.type !== "user") continue;
    const blocks = contentBlocks(message);
    if (typeof blocks === "string") continue;
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      if (typeof id !== "string") continue;
      results.set(id, {
        text: toolResultText(block.content),
        isError: block.is_error === true,
      });
    }
  }

  const out: string[] = [];
  out.push(`# ${header.title?.trim() || "Untitled session"}`, "");
  const rows = [
    headerRow("Provider", header.provider),
    headerRow("Model", header.model),
    headerRow("Project", header.projectName),
    headerRow("Created", formatTimestamp(header.createdAt)),
    headerRow("Updated", formatTimestamp(header.updatedAt)),
    ...(options.extraHeaderRows ?? []).map(([label, value]) =>
      headerRow(label, value ?? undefined),
    ),
  ].filter(Boolean);
  if (rows.length > 0) out.push(...rows, "");

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const time = formatTimestamp(message.timestamp);
    const suffix = time ? ` · ${time}` : "";

    if (message.type === "system") {
      if (message.subtype === "compact_boundary") {
        out.push("---", "", "_Context compacted._", "");
        if (typeof message.content === "string" && message.content.trim()) {
          out.push(
            "<details><summary>Compaction summary</summary>",
            "",
            message.content.trim(),
            "",
            "</details>",
            "",
          );
        }
      }
      continue;
    }

    if (message.type === "summary") {
      const summary = message.summary;
      if (typeof summary === "string" && summary.trim()) {
        out.push(`> Summary: ${summary.trim()}`, "");
      }
      continue;
    }

    if (message.type !== "user" && message.type !== "assistant") continue;
    const blocks = contentBlocks(message);

    if (message.type === "user") {
      const texts: string[] = [];
      if (typeof blocks === "string") {
        texts.push(blocks);
      } else {
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          } else if (block.type === "image") {
            texts.push("[image]");
          }
        }
      }
      const text = texts.join("\n\n").trim();
      // Messages that only carry tool results were already printed inline.
      if (!text) continue;
      out.push(`## User${suffix}`, "", text, "");
      continue;
    }

    const parts: string[] = [];
    if (typeof blocks === "string") {
      if (blocks.trim()) parts.push(blocks.trim());
    } else {
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim()) parts.push(block.text.trim());
        } else if (block.type === "thinking") {
          if (!includeThinking) continue;
          const thinking =
            typeof block.thinking === "string" ? block.thinking.trim() : "";
          if (thinking) {
            parts.push(
              thinking
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n"),
            );
          }
        } else if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          const id = typeof block.id === "string" ? block.id : null;
          const lines = [
            `### Tool: ${name}`,
            "",
            fence(truncate(stringifyInput(block.input), TOOL_INPUT_LIMIT)),
          ];
          const result = id ? results.get(id) : undefined;
          if (result) {
            lines.push(
              "",
              result.isError ? "Result (error):" : "Result:",
              "",
              fence(truncate(result.text, toolOutputLimit)),
            );
          }
          parts.push(lines.join("\n"));
        }
      }
    }
    if (parts.length === 0) continue;
    out.push(`## Assistant${suffix}`, "", parts.join("\n\n"), "");
  }

  return `${out.join("\n").trimEnd()}\n`;
}
