import {
  CURL_COMMAND_LIMIT,
  CurlCommandError,
  type CurlStreamEvent,
  parseCurlCommand,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { z } from "zod";
import { CurlService, CurlServiceError } from "../services/CurlService.js";

const InputSchema = z.object({
  name: z.string().max(120).default(""),
  command: z.string().min(1).max(CURL_COMMAND_LIMIT),
});

export function createCurlRoutes(dataDir: string): Hono {
  const routes = new Hono();
  const service = new CurlService(dataDir);
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  routes.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  routes.onError((error, c) => {
    if (error instanceof CurlCommandError)
      return c.json({ error: `curlInvalid_${error.code}` }, 400);
    if (error instanceof CurlServiceError) {
      return c.json(
        { error: `curlError_${error.code}` },
        error.code === "notFound" ? 404 : error.code === "busy" ? 429 : 500,
      );
    }
    // Do not let JSON parser errors or OS diagnostics echo submitted secrets.
    return c.json({ error: "curlError_request" }, 500);
  });
  routes.get("/", async (c) => c.json(await service.listAll()));
  routes.post("/templates", async (c) => {
    const input = InputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "curlError_input" }, 400);
    return c.json(
      { entry: await service.save(input.data.name, input.data.command) },
      201,
    );
  });
  routes.put("/templates/:id", async (c) => {
    const input = InputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "curlError_input" }, 400);
    return c.json({
      entry: await service.save(
        input.data.name,
        input.data.command,
        c.req.param("id"),
      ),
    });
  });
  routes.delete("/templates/:id", async (c) => {
    await service.remove(c.req.param("id"), "templates");
    return c.json({ deleted: true });
  });
  routes.delete("/history/:id", async (c) => {
    await service.remove(c.req.param("id"), "history");
    return c.json({ deleted: true });
  });
  routes.post("/execute", async (c) => {
    const input = InputSchema.extend({ runId: z.string().uuid() }).safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success) return c.json({ error: "curlError_input" }, 400);
    if (c.req.header("accept")?.includes("application/x-ndjson")) {
      parseCurlCommand(input.data.command);
      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("Cache-Control", "no-store, no-transform");
      c.header("X-Accel-Buffering", "no");
      return stream(c, async (output) => {
        const controller = new AbortController();
        output.onAbort(() => controller.abort());
        let writes = Promise.resolve();
        let queuedBytes = 0;
        const emit = (event: CurlStreamEvent) => {
          if (controller.signal.aborted) return;
          const line = `${JSON.stringify(event)}\n`;
          const bytes = Buffer.byteLength(line);
          queuedBytes += bytes;
          // Slow/disconnected clients must not create an unbounded write queue.
          // Account for JSON's worst-case 6x escaping and the final snapshot.
          if (queuedBytes > 32 * 1024 * 1024) {
            controller.abort();
            output.abort();
            return;
          }
          writes = writes.then(async () => {
            if (!controller.signal.aborted) await output.write(line);
            queuedBytes -= bytes;
          });
        };
        emit({ type: "start" });
        const heartbeat = setInterval(() => emit({ type: "ping" }), 15_000);
        try {
          const result = await service.execute(
            input.data.name,
            input.data.command,
            input.data.runId,
            emit,
            controller.signal,
          );
          emit({ type: "complete", result });
        } catch (error) {
          emit({
            type: "error",
            error:
              error instanceof CurlServiceError
                ? `curlError_${error.code}`
                : error instanceof CurlCommandError
                  ? `curlInvalid_${error.code}`
                  : "curlError_request",
          });
        } finally {
          clearInterval(heartbeat);
          await writes;
        }
      });
    }
    return c.json(
      await service.execute(
        input.data.name,
        input.data.command,
        input.data.runId,
      ),
    );
  });
  routes.post("/cancel/:id", (c) =>
    c.json({ cancelled: service.cancel(c.req.param("id")) }),
  );
  return routes;
}
