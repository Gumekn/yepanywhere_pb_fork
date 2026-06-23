import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ReportDocument,
  ReportDocumentResponse,
  ReportsListResponse,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";

export interface ReportsDeps {
  reportsDir?: string;
}

const MAX_DOCUMENTS = 500;
const MAX_SCAN_DEPTH = 5;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

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
  if (!isMarkdownPath(candidate)) return null;

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

    return {
      path: toPosixPath(relative(root, filePath)),
      title: titleFromMarkdown(content, filePath),
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

    if (entry.isFile() && isMarkdownPath(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
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

      const renderedHtml = await renderMarkdownToHtml(content);
      return c.json({
        metadata: {
          path: toPosixPath(relative(root, filePath)),
          title: titleFromMarkdown(content, filePath),
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
