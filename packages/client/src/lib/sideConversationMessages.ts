import type {
  AppContentBlock,
  SideConversationBlock,
  SideConversationMessage,
  SideConversationSnapshot,
} from "@yep-anywhere/shared";
import type { Message } from "../types";

/**
 * The prompt with the same attachment manifest MessageQueue appends to main
 * prompts, so the shared prompt block shows the images as attachment chips.
 * Side snapshots keep names only, never paths.
 */
function sidePromptText(message: SideConversationMessage): string {
  const files = message.attachments ?? [];
  if (files.length === 0) return message.text;
  // Size is unknown here; it only ever appears in the chip's tooltip.
  const rows = files.map(
    (file) => `- ${file.name} (—, ${file.mimeType}): ${file.name}`,
  );
  return `${message.text}\n\nUser uploaded files:\n${rows.join("\n")}`;
}

/**
 * Project a side conversation onto the main transcript's message model so the
 * panel can render it with the same `MessageList` pipeline: user prompts,
 * reasoning, tool rows paired with their results, and prose.
 */
export function sideConversationToMessages(
  conversation: SideConversationSnapshot | undefined,
): Message[] {
  if (!conversation) return [];
  const running =
    conversation.status === "running" || conversation.status === "stopping";
  const last = conversation.messages.at(-1);
  const messages: Message[] = [];
  for (const message of conversation.messages) {
    if (message.role === "user") {
      messages.push({
        type: "user",
        uuid: `side-user-${message.id}`,
        timestamp: message.timestamp,
        message: { role: "user", content: sidePromptText(message) },
      });
      continue;
    }
    // Servers before structured side content only send prose.
    const blocks: SideConversationBlock[] =
      message.blocks ??
      (message.text
        ? [{ type: "text", text: message.text, html: message.html }]
        : []);
    const content: AppContentBlock[] = [];
    const results: AppContentBlock[] = [];
    const unanswered: string[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        content.push({
          type: "text",
          text: block.text,
          ...(block.html ? { _html: block.html } : {}),
        });
      } else if (block.type === "thinking") {
        content.push({ type: "thinking", thinking: block.thinking });
      } else {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        if (block.result)
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: block.result.content,
            is_error: block.result.isError === true,
          });
        else if (!running) unanswered.push(block.id);
      }
    }
    if (content.length === 0) continue;
    const uuid = `side-assistant-${message.id}`;
    messages.push({
      type: "assistant",
      uuid,
      timestamp: message.timestamp,
      message: { role: "assistant", content },
      ...(message.phase ? { codexMessagePhase: message.phase } : {}),
      ...(running && message === last ? { _isStreaming: true } : {}),
      // A finished turn never answers these calls: show them as interrupted.
      ...(unanswered.length > 0 ? { orphanedToolUseIds: unanswered } : {}),
    });
    if (results.length > 0)
      messages.push({
        type: "user",
        uuid: `${uuid}-results`,
        timestamp: message.timestamp,
        message: { role: "user", content: results },
      });
  }
  return messages;
}
