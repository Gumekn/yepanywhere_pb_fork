/**
 * Markdown augments - Render complete markdown text blocks to HTML
 *
 * This module provides functions to render full markdown text to HTML
 * with shiki syntax highlighting. Used when loading historical messages
 * to ensure identical rendering to the streaming path.
 */

import { memoizeAsyncByString } from "../utils/charBudgetLruCache.js";
import {
  type AugmentGenerator,
  type AugmentGeneratorConfig,
  createAugmentGenerator,
} from "./augment-generator.js";
import { BlockDetector } from "./block-detector.js";

/**
 * Default configuration for the AugmentGenerator.
 * Should match the streaming coordinator config.
 */
const DEFAULT_CONFIG: AugmentGeneratorConfig = {
  languages: [
    "javascript",
    "js",
    "typescript",
    "ts",
    "tsx",
    "python",
    "bash",
    "json",
    "css",
    "html",
    "yaml",
    "sql",
    "go",
    "rust",
    "diff",
  ],
};

// Singleton generator instance (initialized lazily)
let generatorPromise: Promise<AugmentGenerator> | null = null;

/**
 * Get or create the shared AugmentGenerator instance.
 * Uses a singleton to avoid re-loading shiki themes/languages.
 */
async function getGenerator(): Promise<AugmentGenerator> {
  if (!generatorPromise) {
    generatorPromise = createAugmentGenerator(DEFAULT_CONFIG);
  }
  return generatorPromise;
}

/**
 * Render markdown text to HTML with syntax highlighting.
 *
 * This uses the same BlockDetector and AugmentGenerator as the streaming
 * path, ensuring identical output for the same input.
 *
 * Results are memoized by input text (see CACHE_MAX_CHARS): assistant text
 * blocks, ExitPlanMode plans, and .md write previews are deterministic, so a
 * cache hit returns byte-identical HTML while skipping the shiki render.
 *
 * @param markdown - The markdown text to render
 * @returns The rendered HTML string
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  if (!markdown.trim()) {
    return "";
  }
  return cachedRenderMarkdownToHtml(markdown);
}

export function extractTaskNotificationResult(content: unknown): string | null {
  const text = getTaskNotificationText(content);
  if (!text) {
    return null;
  }

  const result = extractXmlTag(text, "result");
  return result ? decodeXmlEntities(result) : null;
}

function getTaskNotificationText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trimStart().startsWith("<task-notification>")
      ? content
      : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      return "";
    })
    .join("\n");

  return text.trimStart().startsWith("<task-notification>") ? text : null;
}

function extractXmlTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** ~8M chars (≈16MB UTF-16) of distinct markdown inputs retained. */
const CACHE_MAX_CHARS = 8_000_000;

const cachedRenderMarkdownToHtml = memoizeAsyncByString(
  renderMarkdownToHtmlUncached,
  { maxChars: CACHE_MAX_CHARS },
);

async function renderMarkdownToHtmlUncached(markdown: string): Promise<string> {
  const generator = await getGenerator();
  const detector = new BlockDetector();

  // Feed the entire markdown text at once
  const completedBlocks = detector.feed(markdown);

  // Flush any remaining content
  const finalBlocks = detector.flush();

  // Combine all blocks
  const allBlocks = [...completedBlocks, ...finalBlocks];

  // Render each block and concatenate HTML
  const htmlParts: string[] = [];
  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i];
    if (!block) continue;
    const augment = await generator.processBlock(block, i);
    htmlParts.push(augment.html);
  }

  return htmlParts.join("\n");
}

/**
 * Augment text blocks with pre-rendered HTML.
 *
 * Mutates text blocks in assistant messages, adding `_html` field
 * with rendered markdown/syntax-highlighted content.
 *
 * @param messages - Array of messages from session (mutated in place)
 */
export async function augmentTextBlocks(
  messages: Array<{
    type?: string;
    message?: { content?: unknown };
    content?: unknown;
  }>,
): Promise<void> {
  // Process all messages in parallel
  const messagePromises = messages.map(async (msg) => {
    const taskNotificationResult = extractTaskNotificationResult(
      msg.message?.content ?? msg.content,
    );
    if (taskNotificationResult) {
      try {
        const html = await renderMarkdownToHtml(taskNotificationResult);
        (
          msg as { _taskNotificationResultHtml?: string }
        )._taskNotificationResultHtml = html;
        if (msg.message && typeof msg.message === "object") {
          (
            msg.message as { _taskNotificationResultHtml?: string }
          )._taskNotificationResultHtml = html;
        }
      } catch (err) {
        // Ignore errors during augmentation
      }
      return;
    }

    // Only process assistant messages
    if (msg.type !== "assistant") return;

    // Get content from nested message object (SDK structure) or top-level
    const content = msg.message?.content ?? msg.content;
    if (typeof content === "string") {
      if (!content.trim()) return;
      try {
        const html = await renderMarkdownToHtml(content);
        (msg as { _html?: string })._html = html;
        if (msg.message && typeof msg.message === "object") {
          (msg.message as { _html?: string })._html = html;
        }
      } catch (err) {
        // Ignore errors during augmentation
      }
      return;
    }

    if (!Array.isArray(content)) return;

    // Process all text blocks in the message
    const blockPromises = content.map(async (block) => {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim() !== ""
      ) {
        try {
          const html = await renderMarkdownToHtml(block.text);
          (block as { _html?: string })._html = html;
        } catch (err) {
          // Ignore errors during augmentation
        }
      }
    });

    await Promise.all(blockPromises);
  });

  await Promise.all(messagePromises);
}
