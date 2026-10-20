import type {
  CurlExecutionResult,
  CurlResponse,
  CurlStreamEvent,
} from "@yep-anywhere/shared";
import { fetchResponse } from "./client";

export interface CurlExecution {
  result: Promise<CurlExecutionResult>;
  response: CurlResponse;
  subscribe(listener: (response: CurlResponse) => void): () => void;
}

/** One fetch for the entire run, retained across SPA navigation. Never retries a POST. */
export function startCurlExecution(
  name: string,
  command: string,
  runId: string,
): CurlExecution {
  const listeners = new Set<(response: CurlResponse) => void>();
  const execution: CurlExecution = {
    response: {
      status: 0,
      durationMs: 0,
      error: null,
      headers: "",
      body: "",
      size: 0,
      truncated: false,
    },
    get result() {
      return resultPromise;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(execution.response);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const publish = () => {
    for (const listener of listeners) listener(execution.response);
  };
  const resultPromise = (async () => {
    const response = await fetchResponse("/curl/execute", {
      method: "POST",
      headers: { Accept: "application/x-ndjson" },
      body: JSON.stringify({ name, command, runId }),
    });
    // Compatible with an older server during a staged client/server update.
    if (response.headers.get("content-type")?.includes("application/json")) {
      const result = (await response.json()) as CurlExecutionResult;
      execution.response = result.response;
      publish();
      return result;
    }
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("application/x-ndjson")
    ) {
      throw new Error("curlError_streamInterrupted");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal: CurlExecutionResult | undefined;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as CurlStreamEvent;
      if (event.type === "data") {
        execution.response = {
          ...execution.response,
          body: execution.response.body + event.data,
          size: event.size,
          durationMs: event.durationMs,
        };
      } else if (event.type === "headers") {
        execution.response = {
          ...execution.response,
          headers: execution.response.headers + event.data,
          status: event.status,
          durationMs: event.durationMs,
        };
      } else if (event.type === "complete") {
        terminal = event.result;
        execution.response = event.result.response;
      } else if (event.type === "error") {
        throw new Error(event.error);
      } else if (event.type !== "start" && event.type !== "ping") {
        throw new Error("curlError_streamInterrupted");
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          consume(line);
          index = buffer.indexOf("\n");
        }
        if (done && buffer.trim()) consume(buffer);
        publish();
        if (terminal) return terminal;
        if (done) throw new Error("curlError_streamInterrupted");
        // A final frame can contain the bounded 2 MB body with JSON escaping.
        if (buffer.length > 16 * 1024 * 1024)
          throw new Error("curlError_streamInterrupted");
      }
    } catch (error) {
      // Keep every byte received so far, and distinguish a lost relay from an
      // upstream HTTP error. Do not silently submit the request a second time.
      execution.response = { ...execution.response, error: "network" };
      publish();
      if (
        error instanceof Error &&
        /^curl(?:Error|Invalid)_/.test(error.message)
      )
        throw error;
      throw new Error("curlError_streamInterrupted");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
  return execution;
}
