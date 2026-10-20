// @vitest-environment node
import type { CurlExecutionResult } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startCurlExecution } from "./curl";

const mocks = vi.hoisted(() => ({ fetchResponse: vi.fn() }));
vi.mock("./client", () => ({ fetchResponse: mocks.fetchResponse }));
const result: CurlExecutionResult = {
  entry: {
    id: "test",
    name: "Test",
    command: "curl https://example.test",
    updatedAt: "",
    run: null,
  },
  response: {
    body: "你好",
    headers: "Content-Type: text/plain",
    status: 200,
    durationMs: 20,
    size: 6,
    error: null,
    truncated: false,
  },
  historySaved: true,
};

describe("cURL streaming transport", () => {
  beforeEach(() => mocks.fetchResponse.mockReset());

  it("publishes body chunks before completion and decodes split UTF-8 transport frames", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    mocks.fetchResponse.mockResolvedValue(
      new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
    const execution = startCurlExecution(
      "Test",
      "curl https://example.test",
      "id",
    );
    let completed = false;
    void execution.result.then(() => {
      completed = true;
    });
    const seen: string[] = [];
    execution.subscribe((response) => seen.push(response.body));
    const frame = Buffer.from(
      `${JSON.stringify({ type: "data", data: "你好", size: 6, durationMs: 10 })}\n`,
    );
    const split = frame.indexOf(Buffer.from("你")) + 1;
    controller.enqueue(frame.subarray(0, split));
    controller.enqueue(frame.subarray(split));
    await vi.waitFor(() => expect(seen).toContain("你好"));
    expect(completed).toBe(false);
    expect(seen.join("")).not.toContain("�");
    controller.enqueue(
      Buffer.from(`${JSON.stringify({ type: "complete", result })}\n`),
    );
    controller.close();
    expect(await execution.result).toEqual(result);
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("preserves partial data and fails an EOF without a terminal result instead of retrying", async () => {
    const body = `${JSON.stringify({ type: "data", data: "partial", size: 7, durationMs: 10 })}\n`;
    mocks.fetchResponse.mockResolvedValue(
      new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
    const execution = startCurlExecution("", "curl https://example.test", "id");
    await expect(execution.result).rejects.toThrow(
      "curlError_streamInterrupted",
    );
    expect(execution.response).toMatchObject({
      body: "partial",
      error: "network",
    });
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps typed server failures and accepts a legacy JSON response", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(
      new Response('{"type":"error","error":"curlError_busy"}\n', {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
    await expect(
      startCurlExecution("", "curl https://example.test", "id").result,
    ).rejects.toThrow("curlError_busy");
    mocks.fetchResponse.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(
      await startCurlExecution("", "curl https://example.test", "id2").result,
    ).toEqual(result);
  });
});
