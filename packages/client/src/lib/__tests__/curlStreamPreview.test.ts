import { describe, expect, it } from "vitest";
import { CurlStreamProjector } from "../curlStreamPreview";

const headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n";
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe("AI cURL stream preview", () => {
  it("frames fragmented CRLF, comments, BOM and multiline data without parsing incomplete events", () => {
    const projector = new CurlStreamProjector();
    const first =
      '\uFEFF: keepalive\r\n\r\nevent: message\r\ndata: {"choices":\r';
    expect(projector.update(first, headers).events).toBe(0);
    const complete = `${first}\ndata: [{"index":0,"delta":{"content":"你好"}}]}\r\n\r\n`;
    expect(projector.update(complete, headers)).toMatchObject({
      events: 1,
      text: "你好",
    });
    expect(projector.update(complete, headers).text).toBe("你好");
    expect(projector.update(`${complete}data: [DONE]\r\r`, headers).done).toBe(
      true,
    );
  });

  it("combines chat text, reasoning, tool arguments and usage while preserving the primary choice", () => {
    const source = [
      data({
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "Think", reasoning: "Think" },
          },
        ],
      }),
      data({
        choices: [
          { index: 1, delta: { content: "Other" } },
          {
            index: 0,
            delta: {
              content: "Hello",
              tool_calls: [
                { index: 0, function: { name: "lookup", arguments: '{"q":' } },
              ],
            },
          },
        ],
      }),
      data({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"test"}' } }],
            },
          },
        ],
      }),
      data({ choices: [], usage: { total_tokens: 12 } }),
      "data: [DONE]\n\n",
    ].join("");
    expect(new CurlStreamProjector().update(source, headers)).toMatchObject({
      text: "Hello",
      reasoning: "Think",
      done: true,
      usage: { total_tokens: 12 },
      tools: [{ name: "lookup", arguments: '{"q":"test"}' }],
    });
  });

  it("renders Responses deltas without appending final snapshots a second time", () => {
    const source = [
      data({ type: "response.reasoning_summary_text.delta", delta: "Reason" }),
      data({ type: "response.output_text.delta", delta: "Answer" }),
      data({ type: "response.output_text.done", text: "Answer" }),
      data({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", name: "read" },
      }),
      data({
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"path":"x"}',
      }),
      data({
        type: "response.completed",
        response: { usage: { output_tokens: 5 } },
      }),
    ].join("");
    expect(new CurlStreamProjector().update(source, headers)).toMatchObject({
      text: "Answer",
      reasoning: "Reason",
      done: true,
      tools: [{ name: "read", arguments: '{"path":"x"}' }],
      usage: { output_tokens: 5 },
    });
  });

  it("renders Anthropic thinking, text and incremental tool input and Gemini text", () => {
    const source = [
      data({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
      data({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Reason" },
      }),
      data({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Answer" },
      }),
      data({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", name: "read", input: {} },
      }),
      data({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"file":"x"}' },
      }),
      data({ type: "message_delta", usage: { output_tokens: 5 } }),
      data({ type: "message_stop" }),
    ].join("");
    expect(new CurlStreamProjector().update(source, headers)).toMatchObject({
      text: "Answer",
      reasoning: "Reason",
      done: true,
      usage: { input_tokens: 10, output_tokens: 5 },
      tools: [{ name: "read", arguments: '{"file":"x"}' }],
    });
    expect(
      new CurlStreamProjector().update(
        data({
          candidates: [
            {
              content: {
                parts: [{ text: "Think", thought: true }, { text: "Hi" }],
              },
            },
          ],
        }),
        headers,
      ),
    ).toMatchObject({ text: "Hi", reasoning: "Think" });
  });

  it("retains previous text on upstream errors, recognizes unlabelled SSE and resets for another response", () => {
    const projector = new CurlStreamProjector();
    const source =
      data({ choices: [{ delta: { content: "Partial" } }] }) +
      data({ type: "error", error: { message: "Overloaded" } });
    expect(projector.update(source, "")).toMatchObject({
      text: "Partial",
      error: "Overloaded",
      isSse: true,
    });
    expect(
      projector.update('{"ok":true}', "Content-Type: application/json"),
    ).toMatchObject({ isSse: false, text: "", events: 0 });
  });
});
