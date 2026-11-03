import { randomUUID } from "node:crypto";
import type { SideConversationBlock } from "@yep-anywhere/shared";
import {
  canonicalizePiToolName,
  normalizePiToolInput,
} from "../sessions/pi-tools.js";
import type { SideEvent, SideTransport } from "./session.js";

export const PI_SIDE_COMMAND = "yep:side-v1";
export const PI_SIDE_PREFIX = "__YEP_PI_SIDE_V1__:";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Pi assistant content in the shape the main Pi transcript renders. */
export function piSideBlocks(content: unknown): SideConversationBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): SideConversationBlock[] => {
    const part = record(value);
    if (part?.type === "text" && typeof part.text === "string")
      return [{ type: "text", text: part.text }];
    if (part?.type === "thinking" && typeof part.thinking === "string")
      return [{ type: "thinking", thinking: part.thinking }];
    if (
      part?.type === "toolCall" &&
      typeof part.id === "string" &&
      typeof part.name === "string"
    )
      return [
        {
          type: "tool_use",
          id: part.id,
          name: canonicalizePiToolName(part.name),
          input: normalizePiToolInput(part.name, part.arguments),
        },
      ];
    return [];
  });
}

/** Dedicated RPC event dispatcher, independent of the parent's turn-consumption loop. */
export class PiSideChannel {
  readonly token = randomUUID();
  private readonly pending = new Map<
    string,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly sinks = new Map<string, (event: SideEvent) => void>();
  constructor(
    private readonly send: (
      command: Record<string, unknown>,
    ) => Promise<{ data?: unknown }>,
  ) {}

  accept(value: Record<string, unknown>): boolean {
    if (
      value.type !== "extension_ui_request" ||
      value.method !== "notify" ||
      typeof value.message !== "string" ||
      !value.message.startsWith(PI_SIDE_PREFIX)
    )
      return false;
    try {
      const event = JSON.parse(value.message.slice(PI_SIDE_PREFIX.length));
      if (event.type === "control" && typeof event.requestId === "string") {
        const pending = this.pending.get(event.requestId);
        if (pending) {
          this.pending.delete(event.requestId);
          clearTimeout(pending.timer);
          if (typeof event.error === "string")
            pending.reject(new Error(event.error));
          else pending.resolve(event.data ?? {});
        }
      } else if (typeof event.id === "string") {
        const sink = this.sinks.get(event.id);
        if (
          event.type === "text" &&
          typeof event.messageId === "string" &&
          typeof event.text === "string"
        )
          sink?.({
            type: "text",
            id: event.messageId,
            text: event.text,
            append: event.append === true,
          });
        else if (
          event.type === "thinking" &&
          typeof event.messageId === "string" &&
          typeof event.text === "string"
        )
          sink?.({
            type: "thinking",
            id: event.messageId,
            text: event.text,
            append: event.append === true,
          });
        else if (event.type === "blocks" && typeof event.messageId === "string")
          sink?.({
            type: "blocks",
            id: event.messageId,
            blocks: piSideBlocks(event.content),
          });
        else if (
          event.type === "tool_result" &&
          typeof event.toolCallId === "string" &&
          typeof event.text === "string"
        )
          sink?.({
            type: "tool_result",
            toolUseId: event.toolCallId,
            content: event.text,
            isError: event.isError === true,
          });
        else if (event.type === "activity")
          sink?.({
            type: "activity",
            text: typeof event.text === "string" ? event.text : undefined,
          });
        else if (event.type === "done")
          sink?.({
            type: "done",
            error: typeof event.error === "string" ? event.error : undefined,
            usage: event.usage,
          });
        else if (event.type === "closed") sink?.({ type: "closed" });
      }
    } catch {
      /* Malformed side packets cannot enter or break the main transcript. */
    }
    return true;
  }

  private async command(
    id: string,
    action: string,
    fields: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Pi side command timed out"));
      }, 30_000);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    // Attach rejection handling before awaiting the RPC ack to avoid an unhandled timeout.
    const ack = this.send({
      type: "prompt",
      message: `/${PI_SIDE_COMMAND} ${JSON.stringify({ token: this.token, id, requestId, action, ...fields })}`,
    });
    try {
      return (await Promise.all([result, ack]))[0];
    } finally {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
      }
    }
  }

  async create(
    context: "snapshot" | "empty",
    emit: (event: SideEvent) => void,
  ): Promise<SideTransport> {
    const response = await this.send({ type: "get_commands" });
    const data = response.data as
      | { commands?: Array<{ name: string; description?: string }> }
      | undefined;
    if (
      !data?.commands?.some(
        (c) =>
          c.name === PI_SIDE_COMMAND &&
          c.description === "Yep private side conversation protocol v1",
      )
    )
      throw new Error(
        "This Pi process does not have the Yep side conversation extension. Start a new session after updating Yep.",
      );
    const id = randomUUID();
    this.sinks.set(id, emit);
    try {
      const info = await this.command(id, "create", { context });
      return {
        model: typeof info.model === "string" ? info.model : undefined,
        reasoningEffort:
          typeof info.reasoningEffort === "string"
            ? info.reasoningEffort
            : undefined,
        send: async (text, _requestId, images = []) => {
          await this.command(id, "send", {
            text,
            ...(images.length > 0
              ? {
                  images: images.map(({ path, mimeType }) => ({
                    path,
                    mimeType,
                  })),
                }
              : {}),
          });
        },
        interrupt: async () => {
          await this.command(id, "interrupt");
        },
        close: async () => {
          try {
            await this.command(id, "close");
          } finally {
            this.sinks.delete(id);
          }
        },
      };
    } catch (error) {
      await this.command(id, "close").catch(() => {});
      this.sinks.delete(id);
      throw error;
    }
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi provider closed"));
    }
    this.pending.clear();
    for (const sink of this.sinks.values()) sink({ type: "closed" });
    this.sinks.clear();
  }
}
