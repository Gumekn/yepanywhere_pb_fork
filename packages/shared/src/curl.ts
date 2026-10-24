import { z } from "zod";

export const CURL_COMMAND_LIMIT = 128 * 1024;
export const CURL_HISTORY_LIMIT = 100;
export const CURL_TIMEOUT_DEFAULT_SECONDS = 120;
export const CURL_TIMEOUT_MAX_SECONDS = 3600;

export const CurlRequestSchema = z
  .object({
    url: z.string().max(16384),
    method: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/),
    headers: z.array(z.string().max(16384)).max(100),
    body: z.string().max(CURL_COMMAND_LIMIT).nullable(),
    noProxy: z.string().max(4096).nullable(),
    proxy: z.string().max(4096).nullable(),
    basicAuth: z.string().max(4096).nullable(),
    followRedirects: z.boolean(),
    insecure: z.boolean(),
    compressed: z.boolean(),
    timeoutSeconds: z
      .number()
      .positive()
      .max(CURL_TIMEOUT_MAX_SECONDS)
      .nullable(),
  })
  .strict();
export type CurlRequest = z.infer<typeof CurlRequestSchema>;

export const CurlRunSummarySchema = z.object({
  status: z.number().int(),
  durationMs: z.number(),
  error: z
    .enum(["cancelled", "timeout", "tooLarge", "unavailable", "network"])
    .nullable(),
});
export const CurlTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(120),
  command: z.string().max(CURL_COMMAND_LIMIT),
  updatedAt: z.string(),
});
export type CurlTemplate = z.infer<typeof CurlTemplateSchema>;
export const CurlHistoryEntrySchema = CurlTemplateSchema.extend({
  run: CurlRunSummarySchema.nullable(),
});
export type CurlHistoryEntry = z.infer<typeof CurlHistoryEntrySchema>;
export type CurlCollection = "templates" | "history";
export interface CurlCollections {
  templates: CurlTemplate[];
  entries: CurlHistoryEntry[];
}
export type CurlRunSummary = z.infer<typeof CurlRunSummarySchema>;
export interface CurlResponse extends CurlRunSummary {
  headers: string;
  body: string;
  size: number;
  truncated: boolean;
}
export interface CurlExecutionResult {
  entry: CurlHistoryEntry;
  response: CurlResponse;
  historySaved: boolean;
}
export type CurlProgress =
  | { type: "headers"; data: string; status: number; durationMs: number }
  | { type: "data"; data: string; size: number; durationMs: number };
/** One JSON object per line. Upstream SSE remains untouched inside data events. */
export type CurlStreamEvent =
  | CurlProgress
  | { type: "start" | "ping" }
  | { type: "complete"; result: CurlExecutionResult }
  | { type: "error"; error: string };

export type CurlErrorCode =
  | "empty"
  | "command"
  | "quotes"
  | "shell"
  | "option"
  | "value"
  | "url"
  | "multipleUrls"
  | "file"
  | "header"
  | "method"
  | "limit";
export class CurlCommandError extends Error {
  constructor(public readonly code: CurlErrorCode) {
    super(code);
  }
}
function invalid(code: CurlErrorCode): never {
  throw new CurlCommandError(code);
}

// A deliberately strict shell lexer: quotes and line continuations only.
// No shell ever evaluates the command, and unexpanded substitutions are rejected.
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++i];
      if (next === undefined) invalid("quotes");
      if (next === "\n") continue;
      if (next === "\r" && command[i + 1] === "\n") {
        i++;
        continue;
      }
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      started = true;
      continue;
    }
    if (char === "$" || char === "`") invalid("shell");
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(word);
      word = "";
      started = false;
    } else {
      if (/[|;&<>()]/.test(char)) invalid("shell");
      word += char;
      started = true;
    }
  }
  if (quote) invalid("quotes");
  if (started) tokens.push(word);
  return tokens;
}

export function validateCurlRequest(request: CurlRequest): CurlRequest {
  if (request.method === "HEAD" && request.body !== null) invalid("method");
  if (/[\r\n]/.test(request.url)) invalid("url");
  if (!CurlRequestSchema.safeParse(request).success) invalid("limit");
  try {
    const url = new URL(request.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      invalid("url");
  } catch {
    invalid("url");
  }
  if (request.proxy) {
    try {
      if (
        !["http:", "https:", "socks5:", "socks5h:"].includes(
          new URL(request.proxy).protocol,
        )
      )
        invalid("url");
    } catch {
      invalid("url");
    }
  }
  if (
    request.headers.some(
      (header) => !/^[!#$%&'*+.^_`|~\w-]+(?::[^\r\n\0]*|;)$/.test(header),
    )
  )
    invalid("header");
  if (
    Object.values(request).some(
      (value) => typeof value === "string" && value.includes("\0"),
    )
  )
    invalid("value");
  return request;
}

export function parseCurlCommand(command: string): CurlRequest {
  if (!command.trim()) invalid("empty");
  if (command.length > CURL_COMMAND_LIMIT || command.includes("\0"))
    invalid("limit");
  const tokens = tokenize(command.trim());
  if (!["curl", "/usr/bin/curl", "curl.exe"].includes(tokens.shift() ?? ""))
    invalid("command");
  const request: CurlRequest = {
    url: "",
    method: "GET",
    headers: [],
    body: null,
    noProxy: null,
    proxy: null,
    basicAuth: null,
    followRedirects: false,
    insecure: false,
    compressed: false,
    timeoutSeconds: CURL_TIMEOUT_DEFAULT_SECONDS,
  };
  let explicitMethod = false;
  let head = false;
  let get = false;
  let endOptions = false;
  let json = false;
  const setUrl = (value: string) => {
    if (request.url) invalid("multipleUrls");
    request.url = value;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (endOptions || !token.startsWith("-")) {
      setUrl(token);
      continue;
    }
    if (token === "--") {
      endOptions = true;
      continue;
    }
    let option = token;
    let attached: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const index = token.indexOf("=");
      option = token.slice(0, index);
      attached = token.slice(index + 1);
    } else if (/^-[XHduAxm]/.test(token) && token.length > 2) {
      option = token.slice(0, 2);
      attached = token.slice(2);
    }
    const value = () => {
      const result = attached ?? tokens[++i];
      if (result === undefined) invalid("value");
      return result;
    };
    if (/^-[sSLikIGN]+$/.test(option) && attached === undefined) {
      for (const flag of option.slice(1)) {
        if (flag === "L") request.followRedirects = true;
        if (flag === "k") request.insecure = true;
        if (flag === "I") head = true;
        if (flag === "G") get = true;
      }
      continue;
    }
    switch (option) {
      case "--url":
        setUrl(value());
        break;
      case "-X":
      case "--request":
        request.method = value().toUpperCase();
        if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(request.method)) invalid("method");
        explicitMethod = true;
        break;
      case "-H":
      case "--header": {
        const header = value();
        if (header.startsWith("@")) invalid("file");
        request.headers.push(header);
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--json": {
        const data = value();
        if (option !== "--data-raw" && data.startsWith("@")) invalid("file");
        request.body =
          request.body === null
            ? data
            : request.body + (option === "--json" ? "" : "&") + data;
        if (option === "--json") json = true;
        break;
      }
      case "--noproxy":
        request.noProxy = value();
        break;
      case "-x":
      case "--proxy":
        request.proxy = value();
        break;
      case "-u":
      case "--user":
        request.basicAuth = value();
        break;
      case "-A":
      case "--user-agent":
        request.headers.push(`User-Agent: ${value()}`);
        break;
      case "-m":
      case "--max-time": {
        const seconds = Number(value());
        // curl treats 0 as no timeout. Keep that as null so a limit is never 0.
        request.timeoutSeconds = seconds === 0 ? null : seconds;
        break;
      }
      case "--location":
        request.followRedirects = true;
        break;
      case "--insecure":
        request.insecure = true;
        break;
      case "--compressed":
        request.compressed = true;
        break;
      case "--head":
        head = true;
        break;
      case "--get":
        get = true;
        break;
      case "--silent":
      case "--show-error":
      case "--include":
      case "--no-buffer":
      case "--globoff":
        break;
      default:
        invalid("option");
    }
    if (
      attached !== undefined &&
      ![
        "--url",
        "-X",
        "--request",
        "-H",
        "--header",
        "-d",
        "--data",
        "--data-raw",
        "--data-binary",
        "--json",
        "--noproxy",
        "-x",
        "--proxy",
        "-u",
        "--user",
        "-A",
        "--user-agent",
        "-m",
        "--max-time",
      ].includes(option)
    )
      invalid("value");
  }
  if (head && request.body !== null && !get) invalid("method");
  if (head && explicitMethod && request.method !== "HEAD") invalid("method");
  if (get && request.body !== null) {
    try {
      const url = new URL(request.url);
      url.search += (url.search ? "&" : "?") + request.body;
      request.url = url.toString();
    } catch {
      invalid("url");
    }
    request.body = null;
  }
  if (!explicitMethod)
    request.method = head ? "HEAD" : request.body !== null ? "POST" : "GET";
  if (json) {
    for (const name of ["Content-Type", "Accept"]) {
      if (
        !request.headers.some((h) =>
          h.toLowerCase().startsWith(`${name.toLowerCase()}:`),
        )
      )
        request.headers.push(`${name}: application/json`);
    }
  }
  return validateCurlRequest(request);
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function serializeCurlRequest(request: CurlRequest): string {
  // Match the executor's literal URL and unbuffered streaming behavior.
  const parts = [`curl --globoff --no-buffer ${shellQuote(request.url)}`];
  if (request.method === "HEAD") parts.push("--head");
  else parts.push(`-X ${request.method}`);
  for (const header of request.headers) parts.push(`-H ${shellQuote(header)}`);
  if (request.body !== null)
    parts.push(`--data-raw ${shellQuote(request.body)}`);
  if (request.noProxy !== null)
    parts.push(`--noproxy ${shellQuote(request.noProxy)}`);
  if (request.proxy !== null)
    parts.push(`--proxy ${shellQuote(request.proxy)}`);
  if (request.basicAuth !== null)
    parts.push(`--user ${shellQuote(request.basicAuth)}`);
  if (request.followRedirects) parts.push("--location");
  if (request.insecure) parts.push("--insecure");
  if (request.compressed) parts.push("--compressed");
  // curl itself has no default timeout; include the editor's limit explicitly.
  parts.push(`--max-time ${request.timeoutSeconds ?? 0}`);
  return parts.join(" \\\n  ");
}
