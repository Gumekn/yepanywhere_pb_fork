import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ReportDocument,
  ReportDocumentKind,
  ReportDocumentResponse,
  ReportUploadResponse,
  ReportsListResponse,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { sanitizeFilename } from "../uploads/index.js";

export interface ReportsDeps {
  reportsDir?: string;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
}

const MAX_DOCUMENTS = 500;
const MAX_SCAN_DEPTH = 5;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const BILIBILI_TRANSCRIPT_PREFIX = "outputs/bilibili_transcripts/";
const BILIBILI_TRANSCRIPT_FILENAMES = new Map<string, string>([
  ["codex_corrected_speaker_turns.txt", "Codex 校正版"],
  ["deepseek_corrected_speaker_turns.txt", "DeepSeek 校正版"],
  ["speaker_turns.txt", "FunASR 分说话人稿"],
  ["m3_corrected_speaker_turns.txt", "M3 校正版"],
]);
const MANUAL_UPLOAD_PREFIX = "uploads/";
const MANUAL_UPLOAD_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const PUBLIC_MARKDOWN_DIRECTORY_NAMES = new Set(["reports", "research"]);
const INTERNAL_MARKDOWN_DIRECTORY_NAMES = new Set([
  "briefs",
  "codex_chunks",
  "feishu_chunks",
  "notes",
  "prompts",
]);
const INTERNAL_MARKDOWN_FILENAMES = new Set(["readme.md"]);
const INTERNAL_MARKDOWN_NAME_PATTERN = /(^|[_.-])(draft|prompt)([_.-]|$)/i;

function getReportsRoot(configuredDir?: string): string {
  const raw =
    configuredDir ||
    process.env.YEP_REPORTS_DIR ||
    process.env.RESEARCH_TASKS_DIR ||
    "../research_tasks";
  return resolve(process.cwd(), raw);
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

function getBilibiliTranscriptVariant(filePath: string): string | null {
  const filename = basename(filePath).toLowerCase();
  const normalizedFilename = filename.replace(/\.md$/, ".txt");
  return BILIBILI_TRANSCRIPT_FILENAMES.get(normalizedFilename) ?? null;
}

function isBilibiliTranscriptPath(root: string, filePath: string): boolean {
  const relativePath = toPosixPath(relative(root, filePath));
  if (!relativePath.startsWith(BILIBILI_TRANSCRIPT_PREFIX)) return false;
  return getBilibiliTranscriptVariant(filePath) !== null;
}

function isManualUploadedTextPath(root: string, filePath: string): boolean {
  const relativePath = toPosixPath(relative(root, filePath));
  if (!relativePath.startsWith(MANUAL_UPLOAD_PREFIX)) return false;
  return extname(filePath).toLowerCase() === ".txt";
}

function getReportKind(
  root: string,
  filePath: string,
): ReportDocumentKind | null {
  if (isBilibiliTranscriptPath(root, filePath)) return "transcript";
  if (isMarkdownPath(filePath)) return "markdown";
  if (isManualUploadedTextPath(root, filePath)) return "text";
  return null;
}

function isReadableReportPath(root: string, filePath: string): boolean {
  return getReportKind(root, filePath) !== null;
}

function isListedMarkdownReportPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.at(-1) ?? "";

  if (normalized.startsWith(MANUAL_UPLOAD_PREFIX)) return true;
  if (INTERNAL_MARKDOWN_FILENAMES.has(filename)) return false;
  if (INTERNAL_MARKDOWN_NAME_PATTERN.test(filename)) return false;
  if (parts.some((part) => INTERNAL_MARKDOWN_DIRECTORY_NAMES.has(part))) {
    return false;
  }

  if (parts.length === 1) return true;
  if (PUBLIC_MARKDOWN_DIRECTORY_NAMES.has(parts[0] ?? "")) return true;

  if (parts[0] === "outputs") {
    return parts.length === 3;
  }

  return false;
}

function isListedReportPath(root: string, filePath: string): boolean {
  const relativePath = toPosixPath(relative(root, filePath));
  if (isBilibiliTranscriptPath(root, filePath)) return true;
  if (isManualUploadedTextPath(root, filePath)) return true;
  if (!isMarkdownPath(filePath)) return false;
  return isListedMarkdownReportPath(relativePath);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function resolveReportPath(root: string, relativePath: string): string | null {
  const trimmed = relativePath.trim();
  if (!trimmed || isAbsolute(trimmed)) return null;

  const candidate = resolve(root, trimmed);
  if (!isWithinRoot(root, candidate)) return null;
  if (!isReadableReportPath(root, candidate)) return null;

  return candidate;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function titleFromMarkdown(content: string, fallbackPath: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line.trim());
    if (!match?.[2]) continue;
    return cleanHeadingText(match[2]);
  }

  const name = basename(fallbackPath).replace(/\.(md|markdown)$/i, "");
  return name || fallbackPath;
}

interface UploadedReportFile {
  name: string;
  size: number;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function isUploadedReportFile(value: unknown): value is UploadedReportFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "size" in value &&
    typeof value.size === "number" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function titleFromBilibiliTranscript(filePath: string): Promise<string> {
  const variant = getBilibiliTranscriptVariant(filePath) || "转写稿";

  try {
    const raw = await readFile(join(dirname(filePath), "source.info.json"), {
      encoding: "utf-8",
    });
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return `${basename(dirname(filePath))} (${variant})`;

    const sourceTitle =
      pickString(parsed, "title") ||
      pickString(parsed, "fulltitle") ||
      pickString(parsed, "display_id");
    if (sourceTitle) return `${sourceTitle} (${variant})`;
  } catch {
    // Missing or partial yt-dlp metadata should not hide the transcript itself.
  }

  return `${basename(dirname(filePath))} (${variant})`;
}

async function titleFromReportContent(
  root: string,
  filePath: string,
  content: string,
): Promise<string> {
  const kind = getReportKind(root, filePath);
  if (kind === "transcript") {
    return titleFromBilibiliTranscript(filePath);
  }
  return titleFromMarkdown(content, filePath);
}

function cleanHeadingText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~#]/g, "")
    .trim();
}

async function readReportMetadata(
  root: string,
  filePath: string,
): Promise<ReportDocument | null> {
  try {
    const [stats, content] = await Promise.all([
      stat(filePath),
      readFile(filePath, "utf-8"),
    ]);
    if (!stats.isFile()) return null;
    const kind = getReportKind(root, filePath);
    if (!kind) return null;

    return {
      path: toPosixPath(relative(root, filePath)),
      absolutePath: filePath,
      title: await titleFromReportContent(root, filePath, content),
      kind,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

async function collectMarkdownFiles(
  root: string,
  dir: string,
  depth = 0,
  files: string[] = [],
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || files.length >= MAX_DOCUMENTS) return files;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (files.length >= MAX_DOCUMENTS) break;
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    if (!isWithinRoot(root, fullPath)) continue;

    if (entry.isDirectory()) {
      await collectMarkdownFiles(root, fullPath, depth + 1, files);
      continue;
    }

    if (entry.isFile() && isListedReportPath(root, fullPath)) {
      if (
        isBilibiliTranscriptPath(root, fullPath) &&
        (await hasMarkdownSibling(fullPath))
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }

  return files;
}

async function hasMarkdownSibling(filePath: string): Promise<boolean> {
  const markdownPath = filePath.replace(/\.txt$/i, ".md");
  if (markdownPath === filePath) return false;

  try {
    const stats = await stat(markdownPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export function createReportsRoutes(deps: ReportsDeps = {}): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const files = await collectMarkdownFiles(root, root);
    const documents = (
      await Promise.all(files.map((file) => readReportMetadata(root, file)))
    )
      .filter((doc): doc is ReportDocument => doc !== null)
      .sort(
        (a, b) =>
          new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
      );

    return c.json({
      rootPath: root,
      documents,
    } satisfies ReportsListResponse);
  });

  routes.post("/upload", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const body = await c.req.parseBody();
    const rawFile = body.file;
    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;

    if (!isUploadedReportFile(file)) {
      return c.json({ error: "Missing file" }, 400);
    }

    const extension = extname(file.name).toLowerCase();
    if (!MANUAL_UPLOAD_EXTENSIONS.has(extension)) {
      return c.json(
        { error: "Only .md, .markdown, and .txt reports are supported" },
        400,
      );
    }

    const maxUploadSizeBytes = deps.maxUploadSizeBytes ?? 0;
    if (maxUploadSizeBytes > 0 && file.size > maxUploadSizeBytes) {
      const maxMB = Math.max(1, Math.ceil(maxUploadSizeBytes / (1024 * 1024)));
      return c.json(
        { error: `File size exceeds maximum allowed size of ${maxMB}MB` },
        413,
      );
    }

    const uploadDir = resolve(root, "uploads");
    const { sanitized } = sanitizeFilename(file.name);
    const filePath = resolve(uploadDir, sanitized);
    if (!isWithinRoot(root, filePath) || !isWithinRoot(uploadDir, filePath)) {
      return c.json({ error: "Invalid upload path" }, 400);
    }

    await mkdir(uploadDir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const document = await readReportMetadata(root, filePath);
    if (!document) {
      return c.json({ error: "Uploaded file is not a report" }, 500);
    }

    return c.json({ document } satisfies ReportUploadResponse, 201);
  });

  routes.get("/document", async (c) => {
    const root = getReportsRoot(deps.reportsDir);
    const relativePath = c.req.query("path");
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const filePath = resolveReportPath(root, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid report path" }, 400);
    }

    try {
      const [stats, content] = await Promise.all([
        stat(filePath),
        readFile(filePath, "utf-8"),
      ]);
      if (!stats.isFile()) {
        return c.json({ error: "Report not found" }, 404);
      }
      const kind = getReportKind(root, filePath);
      if (!kind) {
        return c.json({ error: "Report not found" }, 404);
      }

      const renderedHtml = await renderMarkdownToHtml(content);
      return c.json({
        metadata: {
          path: toPosixPath(relative(root, filePath)),
          absolutePath: filePath,
          title: await titleFromReportContent(root, filePath, content),
          kind,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        },
        content,
        renderedHtml,
      } satisfies ReportDocumentResponse);
    } catch {
      return c.json({ error: "Report not found" }, 404);
    }
  });

  return routes;
}
