import { type UrlProjectId, isSlashCommandSession } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { Message, Session } from "../supervisor/types.js";
import type { BusEvent, EventBus } from "../watcher/EventBus.js";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_API_BASE = "https://api.ohmyrouter.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_SCHEDULE_DELAY_MS = 1500;
const DEFAULT_MIN_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MIN_MESSAGE_COUNT_FOR_TITLE = 2;
const MAX_CONTEXT_CHARS = 2400;
const MAX_TITLE_CHARS = 36;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SessionTitleServiceOptions {
  eventBus: EventBus;
  metadataService: SessionMetadataService;
  loadSession: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<Session | null>;
  enabled?: boolean;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
  scheduleDelayMs?: number;
  minRetryIntervalMs?: number;
  fetchImpl?: FetchLike;
}

export class SessionTitleService {
  private readonly eventBus: EventBus;
  private readonly metadataService: SessionMetadataService;
  private readonly loadSession: SessionTitleServiceOptions["loadSession"];
  private readonly enabled: boolean;
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly scheduleDelayMs: number;
  private readonly minRetryIntervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: SessionTitleServiceOptions) {
    this.eventBus = options.eventBus;
    this.metadataService = options.metadataService;
    this.loadSession = options.loadSession;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.scheduleDelayMs = options.scheduleDelayMs ?? DEFAULT_SCHEDULE_DELAY_MS;
    this.minRetryIntervalMs =
      options.minRetryIntervalMs ?? DEFAULT_MIN_RETRY_INTERVAL_MS;
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.enabled = (options.enabled ?? true) && Boolean(this.apiKey);
  }

  start(): void {
    if (!this.enabled || this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
  }

  async generateForSession(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (!this.enabled || this.inFlight.has(sessionId)) return;

    const lastAttempt = this.lastAttemptAt.get(sessionId);
    if (
      lastAttempt !== undefined &&
      Date.now() - lastAttempt < this.minRetryIntervalMs
    ) {
      return;
    }

    const initialMetadata = this.metadataService.getMetadata(sessionId);
    if (initialMetadata?.customTitle || initialMetadata?.aiTitle) return;

    this.inFlight.add(sessionId);
    try {
      const session = await this.loadSession(sessionId, projectId);
      if (!session || session.messageCount < MIN_MESSAGE_COUNT_FOR_TITLE) {
        return;
      }

      const latestMetadata = this.metadataService.getMetadata(sessionId);
      if (latestMetadata?.customTitle || latestMetadata?.aiTitle) return;
      if (
        isSlashCommandSession({
          title: session.fullTitle ?? session.title,
          customTitle: latestMetadata?.customTitle ?? session.customTitle,
        })
      ) {
        return;
      }

      const firstUserMessage =
        session.fullTitle ?? session.title ?? extractFirstUserText(session);
      const firstAssistantMessage = extractFirstAssistantText(session);
      if (!firstUserMessage?.trim() || !firstAssistantMessage?.trim()) return;

      this.lastAttemptAt.set(sessionId, Date.now());
      const title = await this.generateTitle({
        userMessage: firstUserMessage,
        assistantMessage: firstAssistantMessage,
      });
      if (!title) return;

      const metadataBeforeSave = this.metadataService.getMetadata(sessionId);
      if (metadataBeforeSave?.customTitle || metadataBeforeSave?.aiTitle) {
        return;
      }

      await this.metadataService.setAiTitle(sessionId, title);
      this.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        aiTitle: title,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      getLogger().warn(
        { err: error, sessionId, model: this.model },
        "[SessionTitleService] Failed to generate session title",
      );
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private handleEvent(event: BusEvent): void {
    if (event.type === "session-created") {
      if (event.session.messageCount >= MIN_MESSAGE_COUNT_FOR_TITLE) {
        this.schedule(event.session.id, event.session.projectId);
      }
      return;
    }

    if (event.type === "session-updated") {
      if (
        event.messageCount === undefined ||
        event.messageCount >= MIN_MESSAGE_COUNT_FOR_TITLE
      ) {
        this.schedule(event.sessionId, event.projectId);
      }
      return;
    }

    if (event.type === "process-state-changed" && event.activity === "idle") {
      this.schedule(event.sessionId, event.projectId);
    }
  }

  private schedule(sessionId: string, projectId: UrlProjectId): void {
    if (!this.enabled || this.scheduled.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(sessionId);
      void this.generateForSession(sessionId, projectId);
    }, this.scheduleDelayMs);
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    this.scheduled.set(sessionId, timer);
  }

  private async generateTitle(input: {
    userMessage: string;
    assistantMessage: string;
  }): Promise<string | null> {
    if (!this.apiKey) return null;

    const response = await this.fetchImpl(getChatCompletionsUrl(this.apiBase), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-Sub-Module": "yepanywhere-session-title",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          {
            role: "system",
            content:
              'You generate concise chat session titles. Output only JSON: {"title":"..."}. The title should be 4-12 Chinese characters/words or at most 8 English words. No quotes outside JSON, no punctuation, no explanation.',
          },
          {
            role: "user",
            content: [
              "First user message:",
              truncateForPrompt(input.userMessage),
              "",
              "First assistant response:",
              truncateForPrompt(input.assistantMessage),
            ].join("\n"),
          },
        ],
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `title model request failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return sanitizeTitle(content);
  }
}

function getChatCompletionsUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

function truncateForPrompt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_CONTEXT_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_CONTEXT_CHARS);
}

function sanitizeTitle(raw: string): string | null {
  let candidate = raw.trim();
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonCandidate = jsonMatch?.[0];
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as { title?: unknown };
      if (typeof parsed.title === "string") {
        candidate = parsed.title;
      }
    } catch {
      // Fall back to cleaning the raw model output.
    }
  }

  candidate = candidate
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .replace(/^\s*(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[。.!?？；;，,]+$/g, "")
    .trim();

  if (!candidate) return null;
  const chars = Array.from(candidate);
  return chars.slice(0, MAX_TITLE_CHARS).join("");
}

function extractFirstUserText(session: Session): string | null {
  for (const message of session.messages) {
    if (getMessageRole(message) !== "user") continue;
    const text = extractMessageText(message);
    if (text) return text;
  }
  return null;
}

function extractFirstAssistantText(session: Session): string | null {
  let seenUser = false;
  for (const message of session.messages) {
    const role = getMessageRole(message);
    if (role === "user") {
      seenUser = true;
      continue;
    }
    if (!seenUser || role !== "assistant") continue;
    const text = extractMessageText(message);
    if (text) return text;
  }
  return null;
}

function getMessageRole(message: Message): string | undefined {
  const nestedRole = message.message?.role;
  if (typeof nestedRole === "string") return nestedRole;
  const legacyRole = (message as { role?: unknown }).role;
  if (typeof legacyRole === "string") return legacyRole;
  return message.type;
}

function extractMessageText(message: Message): string | null {
  const content = message.message?.content ?? message.content;
  const text = extractContentText(content).trim();
  return text || null;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : undefined;
      if (
        type &&
        (type === "thinking" || type === "tool_use" || type === "tool_result")
      ) {
        return "";
      }
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
