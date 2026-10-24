import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { CurlStreamEvent } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurlRoutes } from "../../src/routes/curl.js";
import { CurlService } from "../../src/services/CurlService.js";

function origin(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

/** Reads actual HTTP response chunks, not mocked service progress callbacks. */
function events(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No stream");
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    cancel: () => reader.cancel(),
    async until(
      predicate: (event: CurlStreamEvent) => boolean,
    ): Promise<CurlStreamEvent> {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const event = JSON.parse(line) as CurlStreamEvent;
          if (predicate(event)) return event;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Unexpected EOF");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe("real cURL → HTTP streaming API", () => {
  let upstream: Server;
  let api: Server;
  let directory: string;
  let accepted: Promise<ServerResponse>;
  let capture: (response: ServerResponse) => void;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "yep-curl-stream-test-"));
    accepted = new Promise((resolve) => {
      capture = resolve;
    });
    upstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
      });
      response.flushHeaders();
      capture(response);
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const app = new Hono();
    // Same compression middleware as the main server; streaming must bypass it.
    app.use("*", compress({ threshold: 1 }));
    app.route("/api/curl", createCurlRoutes(directory));
    await new Promise<void>((resolve) => {
      api = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
        resolve(),
      ) as Server;
    });
  });

  afterEach(async () => {
    upstream.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => api.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  async function start(extra = "") {
    const runId = randomUUID();
    const response = await fetch(`${origin(api)}/api/curl/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify({
        name: "Streaming",
        command: `curl -N --noproxy '*' '${origin(upstream)}' ${extra}`,
        runId,
      }),
    });
    return { response, reader: events(response), runId };
  }

  it("delivers headers and text before upstream completion, with fragmented Chinese and no gzip buffering", async () => {
    const { response, reader } = await start();
    try {
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toContain("no-transform");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const output = await accepted;
      const header = await reader.until((event) => event.type === "headers");
      expect(header).toMatchObject({ status: 200 });
      output.write('data: {"choices":[{"delta":{"content":"First"}}]}\n\n');
      const first = await reader.until((event) => event.type === "data");
      expect(first).toMatchObject({ data: expect.stringContaining("First") });
      expect(output.writableEnded).toBe(false);

      const chinese = Buffer.from(
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      );
      const split = chinese.indexOf(Buffer.from("你")) + 1;
      output.write(chinese.subarray(0, split));
      const partial = await reader.until((event) => event.type === "data");
      expect(partial.type === "data" && partial.data).not.toContain("�");
      output.end(
        Buffer.concat([
          chinese.subarray(split),
          Buffer.from("data: [DONE]\n\n"),
        ]),
      );
      const complete = await reader.until((event) => event.type === "complete");
      if (complete.type !== "complete") throw new Error("Missing result");
      expect(complete.result.response).toMatchObject({
        status: 200,
        error: null,
      });
      expect(complete.result.response.body).toContain("你好");
      expect(complete.result.response.body).toContain("First");
      expect((await new CurlService(directory).list())[0]?.run?.status).toBe(
        200,
      );
    } finally {
      await reader.cancel();
    }
  });

  it("cancels an active stream while retaining its partial body and HTTP status", async () => {
    const { reader, runId } = await start();
    try {
      const output = await accepted;
      output.write("data: partial response\n\n");
      await reader.until((event) => event.type === "data");
      const cancelled = await fetch(`${origin(api)}/api/curl/cancel/${runId}`, {
        method: "POST",
      });
      expect(await cancelled.json()).toEqual({ cancelled: true });
      const complete = await reader.until((event) => event.type === "complete");
      expect(complete).toMatchObject({
        result: {
          response: {
            error: "cancelled",
            status: 200,
            body: "data: partial response\n\n",
          },
        },
      });
    } finally {
      await reader.cancel();
    }
  });

  it("retains partial output when the upstream times out", async () => {
    const { reader } = await start("-m 0.3");
    try {
      (await accepted).write("data: before timeout\n\n");
      const complete = await reader.until((event) => event.type === "complete");
      expect(complete).toMatchObject({
        result: {
          response: { error: "timeout", body: "data: before timeout\n\n" },
        },
      });
    } finally {
      await reader.cancel();
    }
  });

  it("cancels the owned curl process when the HTTP reader disconnects", async () => {
    const { reader } = await start();
    const output = await accepted;
    output.write("data: before disconnect\n\n");
    await reader.until((event) => event.type === "data");
    const closed = new Promise<void>((resolve) =>
      output.on("close", () => resolve()),
    );
    await reader.cancel();
    await closed;
    await vi.waitFor(async () =>
      expect((await new CurlService(directory).list())[0]?.run?.error).toBe(
        "cancelled",
      ),
    );
  });
});
