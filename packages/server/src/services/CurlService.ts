import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  CURL_HISTORY_LIMIT,
  type CurlCollection,
  type CurlCollections,
  type CurlHistoryEntry,
  CurlHistoryEntrySchema,
  type CurlProgress,
  type CurlRequest,
  type CurlResponse,
  type CurlRunSummary,
  type CurlTemplate,
  CurlTemplateSchema,
  parseCurlCommand,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { atomicWriteJson } from "../utils/atomic-json-file.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const LegacyStoreSchema = z
  .object({ entries: z.array(CurlHistoryEntrySchema) })
  .strict();
const StoreSchema = z.object({
  version: z.literal(2),
  templates: z.array(CurlTemplateSchema),
  entries: z.array(CurlHistoryEntrySchema),
});
type Store = z.infer<typeof StoreSchema>;

export class CurlServiceError extends Error {
  constructor(public readonly code: "busy" | "notFound" | "storage") {
    super(code);
  }
}

// curl's config grammar is not shell syntax. Encode all values, including
// multiline JSON, so no input can introduce another config directive.
const configValue = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;

function curlConfig(request: CurlRequest, headerPath: string): string {
  const lines = [
    "silent",
    "show-error",
    "globoff",
    "no-buffer",
    'proto = "=http,https"',
    'proto-redir = "=http,https"',
    "max-redirs = 5",
    "connect-timeout = 15",
    ...(request.timeoutSeconds === null
      ? []
      : [`max-time = ${request.timeoutSeconds}`]),
    `max-filesize = ${MAX_RESPONSE_BYTES}`,
    `dump-header = ${configValue(headerPath)}`,
    'write-out = "%{stderr}\\nYEP_CURL_STATUS:%{http_code}"',
    `url = ${configValue(request.url)}`,
  ];
  if (request.method === "HEAD") lines.push("head");
  else lines.push(`request = ${configValue(request.method)}`);
  for (const header of request.headers)
    lines.push(`header = ${configValue(header)}`);
  if (request.body !== null)
    lines.push(`data-raw = ${configValue(request.body)}`);
  if (request.noProxy !== null)
    lines.push(`noproxy = ${configValue(request.noProxy)}`);
  if (request.proxy !== null)
    lines.push(`proxy = ${configValue(request.proxy)}`);
  if (request.basicAuth !== null)
    lines.push(`user = ${configValue(request.basicAuth)}`);
  if (request.followRedirects) lines.push("location");
  if (request.insecure) lines.push("insecure");
  if (request.compressed) lines.push("compressed");
  return `${lines.join("\n")}\n`;
}

/** Runs only a validated HTTP request. Never invokes a shell or reads curlrc. */
export async function executeCurl(
  request: CurlRequest,
  signal: AbortSignal,
  onProgress?: (event: CurlProgress) => void,
): Promise<CurlResponse> {
  const started = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "yep-curl-"));
  const headerPath = join(directory, "headers");
  try {
    return await new Promise<CurlResponse>((resolve) => {
      // Secrets travel over stdin, not in the process command line.
      const env = { ...process.env };
      env.SSLKEYLOGFILE = undefined;
      const child = spawn("curl", ["-q", "--config", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
      let error: CurlRunSummary["error"] = null;
      let size = 0;
      let stderr = "";
      const chunks: Buffer[] = [];
      const decoder = new StringDecoder("utf8");
      const headerDecoder = new StringDecoder("utf8");
      let pendingText = "";
      let headers = "";
      let headerBytes = 0;
      let headerRead: Promise<void> | undefined;
      const durationMs = () => Math.round(performance.now() - started);
      const headerStatus = () =>
        Number(
          [...headers.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].at(-1)?.[1] ?? 0,
        );
      const stop = (reason: NonNullable<CurlRunSummary["error"]>) => {
        error ??= reason;
        // Only this request's disposable curl process is terminated.
        child.kill("SIGKILL");
      };
      const cancel = () => stop("cancelled");
      signal.addEventListener("abort", cancel, { once: true });
      const timeoutMs =
        request.timeoutSeconds === null
          ? undefined
          : request.timeoutSeconds * 1000 + 1000;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => stop("timeout"), timeoutMs);
      const flushText = () => {
        if (!pendingText) return;
        onProgress?.({
          type: "data",
          data: pendingText,
          size: Math.min(size, MAX_RESPONSE_BYTES),
          durationMs: durationMs(),
        });
        pendingText = "";
      };
      const readHeaders = () => {
        headerRead ??= (async () => {
          try {
            const info = await stat(headerPath);
            if (info.size > MAX_HEADER_BYTES) {
              stop("tooLarge");
              return;
            }
            if (info.size === headerBytes) return;
            const next = await readFile(headerPath);
            if (next.length > MAX_HEADER_BYTES) {
              stop("tooLarge");
              return;
            }
            const delta = headerDecoder.write(next.subarray(headerBytes));
            headerBytes = next.length;
            headers += delta;
            if (delta)
              onProgress?.({
                type: "headers",
                data: delta,
                status: headerStatus(),
                durationMs: durationMs(),
              });
          } catch {
            /* The file does not exist until curl receives headers. */
          }
        })().finally(() => {
          headerRead = undefined;
        });
        return headerRead;
      };
      // Batch tiny token chunks, while checking header limits even before the
      // first body byte. A single read is in flight and queued output is bounded.
      const progressTimer = setInterval(() => {
        void readHeaders();
        flushText();
      }, 50);
      child.stdout.on("data", (chunk: Buffer) => {
        if (request.method === "HEAD") return;
        const remaining = MAX_RESPONSE_BYTES - size;
        if (remaining > 0) {
          const accepted = chunk.subarray(0, remaining);
          chunks.push(accepted);
          pendingText += decoder.write(accepted);
        }
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) stop("tooLarge");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        // Only inspect status metadata. Never return curl diagnostics containing
        // credentials/URLs or log the submitted command.
        stderr = (stderr + chunk.toString("utf8")).slice(-8192);
      });
      child.stdin.on("error", () => {});
      child.on("error", () => {
        error = "unavailable";
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        clearInterval(progressTimer);
        signal.removeEventListener("abort", cancel);
        if (!error && code !== 0)
          error =
            code === 28 ? "timeout" : code === 63 ? "tooLarge" : "network";
        await headerRead;
        await readHeaders();
        const headerTail = headerDecoder.end();
        if (headerTail) {
          headers += headerTail;
          onProgress?.({
            type: "headers",
            data: headerTail,
            status: headerStatus(),
            durationMs: durationMs(),
          });
        }
        pendingText += decoder.end();
        flushText();
        const statusLine = /YEP_CURL_STATUS:(\d{3})\s*$/.exec(stderr);
        resolve({
          status: Number(statusLine?.[1] ?? headerStatus()),
          durationMs: durationMs(),
          error,
          headers,
          body:
            request.method === "HEAD"
              ? ""
              : Buffer.concat(chunks).toString("utf8"),
          size:
            request.method === "HEAD" ? 0 : Math.min(size, MAX_RESPONSE_BYTES),
          truncated: error === "tooLarge",
        });
      });
      if (signal.aborted) cancel();
      else child.stdin.end(curlConfig(request, headerPath));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class CurlService {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private active = new Map<string, AbortController>();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "curl", "history.json");
  }

  private async read(): Promise<Store> {
    try {
      const data = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(data);
      const current = StoreSchema.safeParse(parsed);
      if (current.success) return current.data;
      // Legacy "saved" rows have no run; executed requests are separate rows.
      // Convert in memory, then persist both collections atomically on mutation.
      const legacy = LegacyStoreSchema.parse(parsed);
      return {
        version: 2,
        templates: legacy.entries
          .filter((entry) => entry.run === null)
          .map((entry) => CurlTemplateSchema.parse(entry)),
        entries: legacy.entries.filter((entry) => entry.run !== null),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 2, templates: [], entries: [] };
      throw new CurlServiceError("storage");
    }
  }

  async list(): Promise<CurlHistoryEntry[]> {
    return (await this.listAll()).entries;
  }

  async listAll(): Promise<CurlCollections> {
    await this.queue;
    const { templates, entries } = await this.read();
    return { templates, entries };
  }

  private mutate<T>(change: (store: Store) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const store = await this.read();
      const result = change(store);
      try {
        await atomicWriteJson(this.filePath, {
          ...store,
          entries: store.entries.slice(0, CURL_HISTORY_LIMIT),
        });
      } catch {
        throw new CurlServiceError("storage");
      }
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  save(name: string, command: string, id?: string): Promise<CurlTemplate> {
    parseCurlCommand(command);
    return this.mutate(({ templates }) => {
      if (id && !templates.some((entry) => entry.id === id))
        throw new CurlServiceError("notFound");
      const entry: CurlTemplate = {
        id: id ?? randomUUID(),
        name: name.trim(),
        command,
        updatedAt: new Date().toISOString(),
      };
      const index = templates.findIndex((item) => item.id === id);
      if (index >= 0) templates.splice(index, 1);
      templates.unshift(entry);
      return entry;
    });
  }

  remove(id: string, collection: CurlCollection): Promise<void> {
    return this.mutate((store) => {
      const entries =
        collection === "templates" ? store.templates : store.entries;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new CurlServiceError("notFound");
      entries.splice(index, 1);
    });
  }

  cancel(id: string): boolean {
    const controller = this.active.get(id);
    controller?.abort();
    return Boolean(controller);
  }

  async execute(
    name: string,
    command: string,
    runId: string,
    onProgress?: (event: CurlProgress) => void,
    signal?: AbortSignal,
  ) {
    const request = parseCurlCommand(command);
    if (this.active.size >= 4 || this.active.has(runId))
      throw new CurlServiceError("busy");
    const controller = new AbortController();
    this.active.set(runId, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // Persist before sending: a storage failure must not trigger an unseen request.
      const entry = await this.mutate(({ entries }) => {
        const entry: CurlHistoryEntry = {
          id: randomUUID(),
          name: name.trim(),
          command,
          updatedAt: new Date().toISOString(),
          run: null,
        };
        entries.unshift(entry);
        return entry;
      });
      const response = await executeCurl(
        request,
        controller.signal,
        onProgress,
      );
      entry.run = {
        status: response.status,
        durationMs: response.durationMs,
        error: response.error,
      };
      let historySaved = true;
      try {
        await this.mutate(({ entries }) => {
          const index = entries.findIndex((item) => item.id === entry.id);
          if (index >= 0) entries[index] = entry;
        });
      } catch {
        historySaved = false;
      }
      return { entry, response, historySaved };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.active.delete(runId);
    }
  }
}
