import type { ContentBlock, Message } from "../supervisor/types.js";

function getMessageRole(message: Message): string | undefined {
  const nestedRole = message.message?.role;
  if (nestedRole === "user" || nestedRole === "assistant") {
    return nestedRole;
  }

  const role = message.role;
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }

  return undefined;
}

function getMessageContent(message: Message): unknown {
  return message.message?.content ?? message.content;
}

function isToolResultBlock(block: unknown): block is ContentBlock {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "tool_result"
  );
}

function isMeaningfulPromptBlock(block: unknown): boolean {
  if (isToolResultBlock(block)) {
    return false;
  }

  if (typeof block === "string") {
    return block.trim().length > 0;
  }

  if (!block || typeof block !== "object") {
    return false;
  }

  const typedBlock = block as { type?: unknown; text?: unknown };
  if (typedBlock.type === "text") {
    return typeof typedBlock.text === "string"
      ? typedBlock.text.trim().length > 0
      : false;
  }

  return typeof typedBlock.type === "string";
}

export function isUserPromptMessage(message: Message): boolean {
  if (message.type !== "user" && getMessageRole(message) !== "user") {
    return false;
  }

  const content = getMessageContent(message);
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(isMeaningfulPromptBlock);
}
