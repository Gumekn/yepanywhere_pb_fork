export interface CurlToolPreview {
  id: string;
  name: string;
  arguments: string;
}
export interface CurlStreamPreview {
  isSse: boolean;
  events: number;
  text: string;
  reasoning: string;
  tools: CurlToolPreview[];
  usage: Record<string, unknown>;
  error: string;
  done: boolean;
}
const empty = (): CurlStreamPreview => ({
  isSse: false,
  events: 0,
  text: "",
  reasoning: "",
  tools: [],
  usage: {},
  error: "",
  done: false,
});
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/**
 * Incremental SSE framing: CR, LF, CRLF, comments, BOM and multiline data.
 * Only blank lines dispatch events; an incomplete tail remains visible in raw.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 * AI shapes follow references/pi/packages/ai/src/api/{openai-completions,
 * openai-responses-shared,anthropic-messages,google-generative-ai}.ts.
 */
export class CurlStreamProjector {
  private source = "";
  private line = "";
  private skipLf = false;
  private data: string[] = [];
  private event = "";
  private value = empty();
  private tools = new Map<string, CurlToolPreview>();

  update(body: string, headers: string): CurlStreamPreview {
    if (!body.startsWith(this.source)) {
      this.source = "";
      this.line = "";
      this.skipLf = false;
      this.data = [];
      this.event = "";
      this.value = empty();
      this.tools.clear();
    }
    this.value.isSse ||=
      /content-type:\s*text\/event-stream/i.test(headers) ||
      /^(?:\uFEFF)?(?:data:|event:|:|id:|retry:)/.test(body);
    if (!this.value.isSse) return { ...this.value };
    let addition = body.slice(this.source.length);
    if (!this.source) addition = addition.replace(/^\uFEFF/, "");
    this.source = body;
    for (const char of addition) {
      if (this.skipLf && char === "\n") {
        this.skipLf = false;
        continue;
      }
      this.skipLf = false;
      if (char === "\r" || char === "\n") {
        this.consumeLine();
        this.line = "";
        this.skipLf = char === "\r";
      } else this.line += char;
    }
    return {
      ...this.value,
      tools: [...this.tools.values()].map((tool) => ({ ...tool })),
      usage: { ...this.value.usage },
    };
  }

  private consumeLine() {
    if (!this.line) {
      if (this.data.length) this.consumeEvent(this.data.join("\n"), this.event);
      this.data = [];
      this.event = "";
      return;
    }
    if (this.line.startsWith(":")) return;
    const colon = this.line.indexOf(":");
    const field = colon < 0 ? this.line : this.line.slice(0, colon);
    const value = colon < 0 ? "" : this.line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") this.data.push(value);
    if (field === "event") this.event = value;
  }

  private tool(id: string) {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { id, name: "", arguments: "" };
      this.tools.set(id, tool);
    }
    return tool;
  }

  private consumeEvent(data: string, event: string) {
    this.value.events++;
    if (data.trim() === "[DONE]") {
      this.value.done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Plain SSE text is useful too; malformed JSON stays inspectable in raw.
      if (!/^\s*[{[]/.test(data)) this.value.text += `${data}\n`;
      return;
    }
    const value = record(parsed);
    const type = text(value.type) || event;
    const error = record(value.error);
    const response = record(value.response);
    if (
      Object.keys(error).length ||
      typeof value.error === "string" ||
      type === "error" ||
      type === "response.failed"
    ) {
      this.value.error =
        text(error.message) ||
        text(value.error) ||
        text(value.message) ||
        text(record(response.error).message) ||
        data;
    }
    const usage = record(
      value.usage ??
        record(value.message).usage ??
        response.usage ??
        value.usageMetadata,
    );
    this.value.usage = { ...this.value.usage, ...usage };
    if (["response.completed", "message_stop"].includes(type))
      this.value.done = true;

    // Chat Completions: show the primary choice, retain all choices in raw.
    const choices = array(value.choices).map(record);
    const choice =
      choices.find((item) => item.index === 0) ??
      (choices[0]?.index === undefined ? choices[0] : undefined);
    if (choice) {
      const delta = record(choice.delta);
      this.value.text +=
        text(delta.content) ||
        array(delta.content)
          .map((part) => text(record(part).text))
          .join("") ||
        text(choice.text);
      this.value.reasoning +=
        [delta.reasoning_content, delta.reasoning, delta.reasoning_text]
          .map(text)
          .find(Boolean) ?? "";
      for (const item of array(delta.tool_calls)) {
        const call = record(item);
        const fn = record(call.function);
        const tool = this.tool(`chat:${String(call.index ?? 0)}`);
        tool.name += text(fn.name);
        tool.arguments += text(fn.arguments);
      }
    }
    // Responses events: consume deltas only, never append the final snapshot twice.
    if (["response.output_text.delta", "response.refusal.delta"].includes(type))
      this.value.text += text(value.delta);
    if (
      [
        "response.reasoning_summary_text.delta",
        "response.reasoning_text.delta",
      ].includes(type)
    )
      this.value.reasoning += text(value.delta);
    if (
      type === "response.output_item.added" &&
      record(value.item).type === "function_call"
    ) {
      this.tool(`response:${String(value.output_index ?? 0)}`).name = text(
        record(value.item).name,
      );
    }
    if (type === "response.function_call_arguments.delta")
      this.tool(`response:${String(value.output_index ?? 0)}`).arguments +=
        text(value.delta);

    // Anthropic Messages.
    if (type === "content_block_start") {
      const block = record(value.content_block);
      if (block.type === "text") this.value.text += text(block.text);
      if (block.type === "thinking")
        this.value.reasoning += text(block.thinking);
      if (block.type === "tool_use") {
        const tool = this.tool(`anthropic:${String(value.index ?? 0)}`);
        tool.name = text(block.name);
        if (Object.keys(record(block.input)).length)
          tool.arguments = JSON.stringify(block.input);
      }
    }
    if (type === "content_block_delta") {
      const delta = record(value.delta);
      if (delta.type === "text_delta") this.value.text += text(delta.text);
      if (delta.type === "thinking_delta")
        this.value.reasoning += text(delta.thinking);
      if (delta.type === "input_json_delta")
        this.tool(`anthropic:${String(value.index ?? 0)}`).arguments += text(
          delta.partial_json,
        );
    }
    // Gemini streamGenerateContent with alt=sse.
    const candidate = record(array(value.candidates)[0]);
    for (const item of array(record(candidate.content).parts)) {
      const part = record(item);
      if (part.thought) this.value.reasoning += text(part.text);
      else this.value.text += text(part.text);
    }
  }
}
