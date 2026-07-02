import {
  type SessionQuestion,
  isIdeMetadata,
  stripBridgeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";

export const SESSION_QUESTION_MAX_LENGTH = 140;

const SESSION_SETUP_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
];

export function compactQuestionText(
  text: string,
  maxLength = SESSION_QUESTION_MAX_LENGTH,
): string {
  const normalized = stripBridgeMetadata(stripIdeMetadata(text))
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function isSessionSetupQuestionText(text: string): boolean {
  const trimmed = text.trimStart();
  return SESSION_SETUP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function createSessionQuestion(
  params: {
    id: string | undefined;
    text: string;
    timestamp?: string;
  },
  fallbackId: string,
): SessionQuestion | null {
  if (!params.text.trim()) return null;
  if (isSessionSetupQuestionText(params.text)) return null;

  const compact = compactQuestionText(params.text);
  if (!compact) return null;

  return {
    id: params.id || fallbackId,
    text: compact,
    ...(params.timestamp ? { timestamp: params.timestamp } : {}),
  };
}

export function extractQuestionTextFromContent(
  content:
    | string
    | Array<{
        type?: unknown;
        text?: unknown;
      }>,
): string {
  if (typeof content === "string") {
    return stripBridgeMetadata(stripIdeMetadata(content));
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !isIdeMetadata(block.text)
      ) {
        return stripBridgeMetadata(stripIdeMetadata(block.text));
      }
      if (block.type === "input_image" || block.type === "image") {
        return "[image]";
      }
      if (block.type === "document") {
        return "[document]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
