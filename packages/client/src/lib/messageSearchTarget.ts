import type { SessionDisplayNode } from "@yep-anywhere/shared";
import type { RenderItem } from "../types/renderItems";
import { getMessageId } from "../utils";

/**
 * Whether a render item shows the given message id.
 *
 * Deep links (content search, global search) carry source message ids
 * (`uuid ?? id`). Projected display rows use derived ids such as
 * `text:<id>:<block>`, so they also expose the source ids they stand in for.
 */
export function renderItemContainsMessage(
  item: RenderItem,
  messageId: string,
): boolean {
  if (item.id === messageId) return true;
  return item.sourceMessages.some(
    (source) =>
      getMessageId(source) === messageId ||
      (source._contentSearchIds?.includes(messageId) ?? false),
  );
}

/** Same matching rule against a raw display node (paged history). */
export function displayNodeContainsMessage(
  node: SessionDisplayNode,
  messageId: string,
): boolean {
  if (node.id === messageId) return true;
  if (node.type === "question") return node.question.messageId === messageId;
  const segment = node.segment;
  if (segment.type === "assistant_text") return segment.messageId === messageId;
  if (segment.type === "process")
    return segment.messageIds?.includes(messageId) ?? false;
  return false;
}
