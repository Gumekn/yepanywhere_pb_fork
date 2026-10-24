import type { FileContentResponse } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api/client";
import { useI18n } from "../i18n";
import { appPath } from "../lib/apiPath";
import { writeClipboardText } from "../lib/clipboard";

interface FileViewerProps {
  projectId: string;
  filePath: string;
  onClose?: () => void;
  /** If true, renders as standalone page layout instead of modal content */
  standalone?: boolean;
  /** Line number to scroll to and highlight (1-indexed) */
  lineNumber?: number;
  /** End line for range highlighting (1-indexed). If not provided, only lineNumber is highlighted. */
  lineEnd?: number;
}

type CopyFeedback = "copied" | "failed" | null;

function FileViewerCopyAction({
  value,
  label,
  copiedLabel,
  failedLabel,
  kind,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  kind: "title" | "path" | "content";
}) {
  const [feedback, setFeedback] = useState<CopyFeedback>(null);

  useEffect(() => {
    if (!feedback) return;
    const handle = setTimeout(() => setFeedback(null), 2000);
    return () => clearTimeout(handle);
  }, [feedback]);

  const handleCopy = useCallback(async () => {
    try {
      await writeClipboardText(value);
      setFeedback("copied");
    } catch (err) {
      console.error(`Failed to copy file ${kind}:`, err);
      setFeedback("failed");
    }
  }, [kind, value]);

  const feedbackLabel =
    feedback === "copied"
      ? copiedLabel
      : feedback === "failed"
        ? failedLabel
        : label;

  return (
    <button
      type="button"
      className={`file-viewer-action${
        feedback === "copied"
          ? " copied"
          : feedback === "failed"
            ? " copy-failed"
            : ""
      }`}
      onClick={handleCopy}
      aria-label={feedbackLabel}
      aria-live="polite"
      title={feedbackLabel}
    >
      {feedback === "copied" ? (
        <CheckIcon />
      ) : feedback === "failed" ? (
        <CopyFailedIcon />
      ) : kind === "title" ? (
        <CopyTitleIcon />
      ) : kind === "path" ? (
        <CopyPathIcon />
      ) : (
        <CopyIcon />
      )}
    </button>
  );
}

/**
 * Format file size for display.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get language hint from file extension for potential future syntax highlighting.
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    php: "php",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    markdown: "markdown",
  };
  return langMap[ext] || "plaintext";
}

/**
 * Check if file is markdown.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

interface TocEntry {
  id: string;
  text: string;
  level: number;
}

function extractHeadings(html: string): TocEntry[] {
  if (typeof document === "undefined" || !html) return [];
  const documentFragment = new DOMParser().parseFromString(html, "text/html");
  return Array.from(
    documentFragment.querySelectorAll("h1, h2, h3, h4, h5, h6"),
  ).flatMap((heading) => {
    if (!heading.id) return [];
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelector(".md-heading-anchor")?.remove();
    const text = clone.textContent?.trim();
    return text
      ? [{ id: heading.id, text, level: Number(heading.tagName[1]) }]
      : [];
  });
}

function extOf(filePath: string): string {
  const base = getFilePathParts(filePath).fileName;
  const index = base.lastIndexOf(".");
  return index >= 0 ? base.slice(index + 1).toLowerCase() : "";
}

type PreviewKind = "image" | "pdf" | "docx" | "spreadsheet" | "csv" | "binary";

function getPreviewKind(filePath: string, mimeType: string): PreviewKind {
  const extension = extOf(filePath);
  if (mimeType.startsWith("image/")) return "image";
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "xlsx" || extension === "xls") return "spreadsheet";
  if (extension === "csv" || extension === "tsv") return "csv";
  return "binary";
}

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_SHEET_ROWS = 1000;
const MAX_CSV_ROWS = 5000;

interface SheetView {
  name: string;
  rows: (string | number)[][];
  totalRows: number;
  truncated: boolean;
}

interface ParsedPreview {
  sheets: SheetView[];
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function parseSpreadsheet(buffer: ArrayBuffer): Promise<ParsedPreview> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: "array",
    cellDates: true,
  });
  return {
    sheets: workbook.SheetNames.map((name) => {
      const worksheet = workbook.Sheets[name];
      const rows = worksheet
        ? (XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
            header: 1,
            defval: "",
            raw: false,
            blankrows: false,
          }) as (string | number)[][])
        : [];
      return {
        name,
        rows: rows.slice(0, MAX_SHEET_ROWS),
        totalRows: rows.length,
        truncated: rows.length > MAX_SHEET_ROWS,
      };
    }),
  };
}

async function parseCsv(
  buffer: ArrayBuffer,
  delimiter: string,
): Promise<ParsedPreview> {
  const Papa = (await import("papaparse")).default;
  const result = Papa.parse<unknown[]>(
    new TextDecoder("utf-8").decode(new Uint8Array(buffer)),
    { delimiter, skipEmptyLines: false },
  );
  const rows = result.data as (string | number)[][];
  return {
    sheets: [
      {
        name: "CSV",
        rows: rows.slice(0, MAX_CSV_ROWS),
        totalRows: rows.length,
        truncated: rows.length > MAX_CSV_ROWS,
      },
    ],
  };
}

/**
 * Get filename from path.
 */
function getFilePathParts(filePath: string): {
  fileName: string;
  directory?: string;
} {
  const separatorIndex = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  if (separatorIndex < 0) {
    return { fileName: filePath };
  }

  return {
    fileName: filePath.slice(separatorIndex + 1) || filePath,
    directory:
      separatorIndex === 0 ? filePath[0] : filePath.slice(0, separatorIndex),
  };
}

function getFileName(filePath: string): string {
  return getFilePathParts(filePath).fileName;
}

/**
 * Start a same-document download instead of opening a popup. Android WebView
 * does not implement browser-style popup downloads, but a normal download
 * navigation is handed to its native DownloadListener.
 */
function startFileDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function getErrorFilePath(err: unknown, fallbackPath: string): string | null {
  const apiError = err as Partial<ApiError> | null;
  if (typeof apiError?.absolutePath === "string") {
    return apiError.absolutePath;
  }
  if (typeof apiError?.path === "string" && apiError.path.startsWith("/")) {
    return apiError.path;
  }
  return fallbackPath.startsWith("/") ? fallbackPath : null;
}

function FileViewerHeaderInfo({
  displayPath,
  compactPath,
  meta,
}: {
  displayPath: string;
  compactPath?: string;
  meta?: string;
}) {
  const { fileName, directory } = getFilePathParts(compactPath ?? displayPath);

  return (
    <div className="file-viewer-info">
      <span className="file-viewer-name" title={displayPath}>
        {fileName}
      </span>
      {(directory || meta) && (
        <span className="file-viewer-subtitle">
          {directory && (
            <span className="file-viewer-directory" title={directory}>
              {directory}
            </span>
          )}
          {directory && meta && (
            <span className="file-viewer-meta-separator" aria-hidden="true">
              •
            </span>
          )}
          {meta && <span className="file-viewer-meta">{meta}</span>}
        </span>
      )}
    </div>
  );
}

function FileViewerStateHeader({
  filePath,
  onClose,
  closeLabel,
}: {
  filePath: string;
  onClose?: () => void;
  closeLabel: string;
}) {
  return (
    <div className="file-viewer-header">
      <FileViewerHeaderInfo displayPath={filePath} />
      {onClose && (
        <div className="file-viewer-actions">
          <button
            type="button"
            className="file-viewer-action file-viewer-close"
            onClick={onClose}
            title={closeLabel}
            aria-label={closeLabel}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * FileViewer component - displays file content with appropriate formatting.
 */
export const FileViewer = memo(function FileViewer({
  projectId,
  filePath,
  onClose,
  standalone = false,
  lineNumber,
  lineEnd,
}: FileViewerProps) {
  const { t } = useI18n();
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorFilePath, setErrorFilePath] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [highlightedLineRef, setHighlightedLineRef] =
    useState<HTMLElement | null>(null);
  const [parsedPreview, setParsedPreview] = useState<ParsedPreview | null>(
    null,
  );
  const [rawBytes, setRawBytes] = useState<ArrayBuffer | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const docxRef = useRef<HTMLDivElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const rawUrl = api.getFileRawUrl(projectId, filePath);
  const previewKind = fileData
    ? getPreviewKind(filePath, fileData.metadata.mimeType)
    : "binary";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorFilePath(null);

    // Request highlighting for code files
    api
      .getFile(projectId, filePath, true)
      .then((data) => {
        if (!cancelled) {
          setFileData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("fileViewerLoadFailed" as never));
          setErrorFilePath(getErrorFilePath(err, filePath));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, t]);

  useEffect(() => {
    if (!fileData) return;
    setParsedPreview(null);
    setRawBytes(null);
    setPreviewError(null);

    const kind = getPreviewKind(filePath, fileData.metadata.mimeType);
    if (!(["docx", "spreadsheet", "csv"] as PreviewKind[]).includes(kind))
      return;
    if (fileData.metadata.size > MAX_PREVIEW_BYTES) {
      setPreviewError("too-large");
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    void fetchBytes(rawUrl)
      .then(async (buffer) => {
        if (cancelled) return;
        if (kind === "docx") {
          setRawBytes(buffer);
        } else {
          setParsedPreview(
            kind === "spreadsheet"
              ? await parseSpreadsheet(buffer)
              : await parseCsv(buffer, extOf(filePath) === "tsv" ? "\t" : ","),
          );
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setPreviewError(
            cause instanceof Error ? cause.message : "preview-failed",
          );
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileData, filePath, rawUrl]);

  useEffect(() => {
    if (previewKind !== "docx" || !rawBytes || !docxRef.current) return;
    let cancelled = false;
    setPreviewLoading(true);
    void import("docx-preview")
      .then(async ({ renderAsync }) => {
        if (cancelled || !docxRef.current) return;
        docxRef.current.innerHTML = "";
        await renderAsync(new Blob([rawBytes]), docxRef.current);
      })
      .catch((cause) => {
        if (!cancelled)
          setPreviewError(
            cause instanceof Error ? cause.message : "docx-failed",
          );
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewKind, rawBytes]);

  const scrollToMarkdownHeading = useCallback((id: string) => {
    const heading = markdownRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(id)}`,
    );
    heading?.scrollIntoView({ behavior: "smooth", block: "start" });
    heading?.classList.add("md-heading-flash");
    if (heading) {
      window.setTimeout(
        () => heading.classList.remove("md-heading-flash"),
        1200,
      );
    }
  }, []);

  useEffect(() => {
    const root = markdownRef.current;
    if (!root || !showPreview || !fileData?.renderedMarkdownHtml) return;
    const diagrams = Array.from(
      root.querySelectorAll<HTMLElement>(
        ".mermaid:not([data-mermaid-processed])",
      ),
    );
    const anchors = Array.from(
      root.querySelectorAll<HTMLAnchorElement>("a.md-heading-anchor"),
    );
    const onAnchorClick = (event: Event) => {
      const href = (event.currentTarget as HTMLAnchorElement).getAttribute(
        "href",
      );
      if (!href?.startsWith("#")) return;
      event.preventDefault();
      scrollToMarkdownHeading(decodeURIComponent(href.slice(1)));
    };
    for (const anchor of anchors) {
      anchor.addEventListener("click", onAnchorClick);
    }
    let cancelled = false;
    if (diagrams.length > 0) {
      void import("mermaid")
        .then(({ default: mermaid }) => {
          if (cancelled) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral",
          });
          return mermaid.run({ nodes: diagrams });
        })
        .then(() => {
          if (!cancelled) {
            for (const diagram of diagrams) {
              diagram.setAttribute("data-mermaid-processed", "true");
            }
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      for (const anchor of anchors) {
        anchor.removeEventListener("click", onAnchorClick);
      }
    };
  }, [fileData?.renderedMarkdownHtml, scrollToMarkdownHeading, showPreview]);

  // Handle Escape key to exit fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  // Scroll to highlighted line when it's rendered
  useEffect(() => {
    if (highlightedLineRef) {
      // Small delay to ensure layout is complete
      requestAnimationFrame(() => {
        highlightedLineRef.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    }
  }, [highlightedLineRef]);

  const handleDownload = useCallback(() => {
    const url = api.getFileRawUrl(projectId, filePath, true);
    startFileDownload(url, getFileName(filePath));
  }, [projectId, filePath]);

  const handleOpenInNewTab = useCallback(() => {
    const url = appPath(
      `/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`,
    );
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const fileName = getFileName(filePath);
  const language = getLanguageFromPath(filePath);

  // Render loading state
  if (loading) {
    return (
      <div className="file-viewer">
        <FileViewerStateHeader
          filePath={filePath}
          onClose={onClose}
          closeLabel={t("modalClose")}
        />
        <div className="file-viewer-body">
          <div className="file-viewer-loading">
            {t("fileViewerLoading" as never, { name: fileName })}
          </div>
        </div>
      </div>
    );
  }

  // Render error state
  if (error || !fileData) {
    return (
      <div className="file-viewer">
        <FileViewerStateHeader
          filePath={filePath}
          onClose={onClose}
          closeLabel={t("modalClose")}
        />
        <div className="file-viewer-body">
          <div className="file-viewer-error">
            <div className="file-viewer-error-content">
              <div>{error || t("fileViewerNotFound" as never)}</div>
              {errorFilePath && (
                <div className="file-viewer-error-path">
                  <span>{t("fileViewerAttemptedPath" as never)}</span>
                  <code>{errorFilePath}</code>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { metadata, content } = fileData;
  const displayPath = metadata.absolutePath ?? filePath;
  const fileMeta = [
    formatFileSize(metadata.size),
    metadata.isText && content !== undefined
      ? t("fileViewerLines" as never, {
          count: content.split("\n").length,
        })
      : null,
  ]
    .filter((item): item is string => item !== null)
    .join(" • ");

  // Render content based on file type
  const renderContent = () => {
    // Image files
    if (previewKind === "image") {
      return (
        <div className="file-viewer-image">
          <img src={rawUrl} alt={fileName} />
        </div>
      );
    }

    if (previewKind === "pdf") {
      return (
        <div className="file-viewer-pdf">
          <iframe src={rawUrl} title={fileName} />
        </div>
      );
    }

    if (previewKind === "docx") {
      if (previewError)
        return (
          <PreviewFailure
            tooLarge={previewError === "too-large"}
            onDownload={handleDownload}
          />
        );
      return (
        <div className="file-viewer-docx">
          <div ref={docxRef} className="docx-body" />
          {previewLoading && (
            <div className="file-viewer-loading-inline">
              {t("fileViewerParsing" as never)}
            </div>
          )}
        </div>
      );
    }

    if (previewKind === "spreadsheet" || previewKind === "csv") {
      if (previewError)
        return (
          <PreviewFailure
            tooLarge={previewError === "too-large"}
            onDownload={handleDownload}
          />
        );
      if (previewLoading || !parsedPreview) {
        return (
          <div className="file-viewer-loading-inline">
            {t("fileViewerParsing" as never)}
          </div>
        );
      }
      return <TablePreview data={parsedPreview} />;
    }

    // Text files
    if (content !== undefined) {
      const isMarkdown = isMarkdownFile(filePath);
      const hasMarkdownPreview = isMarkdown && !!fileData.renderedMarkdownHtml;

      // Toggle button for markdown files
      const toggleButton = hasMarkdownPreview && (
        <div className="markdown-view-toggle">
          <button
            type="button"
            className={`toggle-btn ${!showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(false)}
          >
            {t("fileViewerSource" as never)}
          </button>
          <button
            type="button"
            className={`toggle-btn ${showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(true)}
          >
            {t("fileViewerPreview" as never)}
          </button>
        </div>
      );

      // Show rendered markdown preview
      if (showPreview && fileData.renderedMarkdownHtml) {
        const headings = extractHeadings(fileData.renderedMarkdownHtml);
        return (
          <>
            {toggleButton}
            {headings.length > 1 && (
              <details className="markdown-toc" open>
                <summary>{t("fileViewerToc" as never)}</summary>
                <ul>
                  {headings.map((heading) => (
                    <li
                      key={heading.id}
                      className={`markdown-toc-item markdown-toc-level-${heading.level}`}
                    >
                      <button
                        type="button"
                        className="markdown-toc-link"
                        onClick={() => scrollToMarkdownHeading(heading.id)}
                      >
                        {heading.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="markdown-preview">
              <div
                ref={markdownRef}
                className="markdown-rendered"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{
                  __html: fileData.renderedMarkdownHtml,
                }}
              />
            </div>
          </>
        );
      }

      // Server-rendered syntax highlighting (preferred)
      if (fileData.highlightedHtml) {
        return (
          <>
            {toggleButton}
            <div
              className="file-viewer-code file-viewer-code-highlighted"
              data-language={fileData.highlightedLanguage ?? language}
            >
              <div
                className="shiki-container"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{ __html: fileData.highlightedHtml }}
              />
              {fileData.highlightedTruncated && (
                <div className="file-viewer-truncated">
                  {t("fileViewerHighlightTruncated" as never)}
                </div>
              )}
            </div>
          </>
        );
      }

      // Fallback: plain code (no syntax highlighting available)
      const lines = content.split("\n");
      const highlightStart = lineNumber ?? 0;
      const highlightEnd = lineEnd ?? highlightStart;

      return (
        <>
          {toggleButton}
          <div className="file-viewer-code" data-language={language}>
            <div className="code-highlighter-plain">
              <div className="code-line-numbers">
                {lines.map((_, i) => (
                  <div key={`ln-${i + 1}`}>{i + 1}</div>
                ))}
              </div>
              <pre className="code-content">
                <code>
                  {lines.map((line, i) => {
                    const num = i + 1;
                    const isHighlighted =
                      lineNumber &&
                      num >= highlightStart &&
                      num <= highlightEnd;
                    return (
                      <div
                        key={`line-${i + 1}`}
                        ref={
                          lineNumber && num === highlightStart
                            ? (el) => setHighlightedLineRef(el)
                            : undefined
                        }
                        className={
                          isHighlighted ? "highlighted-line" : undefined
                        }
                        style={
                          isHighlighted
                            ? {
                                backgroundColor: "rgba(255, 255, 0, 0.15)",
                                marginLeft: "-0.75rem",
                                marginRight: "-0.75rem",
                                paddingLeft: "0.75rem",
                                paddingRight: "0.75rem",
                              }
                            : undefined
                        }
                      >
                        {line || " "}
                      </div>
                    );
                  })}
                </code>
              </pre>
            </div>
          </div>
        </>
      );
    }

    // Binary files or files too large
    return (
      <div className="file-viewer-binary">
        <p>{t("fileViewerBinary" as never)}</p>
        <p>
          <strong>{t("fileViewerType" as never)}</strong> {metadata.mimeType}
        </p>
        <p>
          <strong>{t("fileViewerSize" as never)}</strong>{" "}
          {formatFileSize(metadata.size)}
        </p>
        <button
          type="button"
          className="file-viewer-download-btn"
          onClick={handleDownload}
        >
          {t("fileViewerDownloadFile" as never)}
        </button>
      </div>
    );
  };

  // Header with file info and actions
  const header = (
    <div className="file-viewer-header">
      <FileViewerHeaderInfo
        displayPath={displayPath}
        compactPath={filePath}
        meta={fileMeta}
      />
      <div className="file-viewer-actions">
        <FileViewerCopyAction
          value={fileName}
          label={t("fileViewerCopyTitle" as never)}
          copiedLabel={t("fileViewerTitleCopied" as never)}
          failedLabel={t("fileViewerTitleCopyFailed" as never)}
          kind="title"
        />
        <FileViewerCopyAction
          value={displayPath}
          label={t("fileViewerCopyPath" as never)}
          copiedLabel={t("fileViewerPathCopied" as never)}
          failedLabel={t("fileViewerPathCopyFailed" as never)}
          kind="path"
        />
        {content !== undefined && (
          <FileViewerCopyAction
            value={content}
            label={t("fileViewerCopyFullText" as never)}
            copiedLabel={t("fileViewerFullTextCopied" as never)}
            failedLabel={t("fileViewerFullTextCopyFailed" as never)}
            kind="content"
          />
        )}
        {!standalone && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleOpenInNewTab}
            title={t("fileViewerOpenNewTab" as never)}
          >
            <ExternalLinkIcon />
          </button>
        )}
        <button
          type="button"
          className="file-viewer-action"
          onClick={handleDownload}
          title={t("fileViewerDownload" as never)}
        >
          <DownloadIcon />
        </button>
        <button
          type="button"
          className="file-viewer-action"
          onClick={() => setFullscreen(!fullscreen)}
          title={
            fullscreen
              ? t("fileViewerExitFullscreen" as never)
              : t("fileViewerFullscreen" as never)
          }
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        {onClose && (
          <button
            type="button"
            className="file-viewer-action file-viewer-close"
            onClick={onClose}
            title={t("modalClose")}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );

  const viewerClass = [
    "file-viewer",
    standalone && "file-viewer-standalone",
    fullscreen && "file-viewer-fullscreen",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={viewerClass}>
      {header}
      <div className="file-viewer-body">{renderContent()}</div>
    </div>
  );
});

function PreviewFailure({
  tooLarge,
  onDownload,
}: {
  tooLarge: boolean;
  onDownload: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="file-viewer-binary">
      <p>
        {t(
          (tooLarge
            ? "fileViewerTooLarge"
            : "fileViewerPreviewFailed") as never,
        )}
      </p>
      <button
        type="button"
        className="file-viewer-download-btn"
        onClick={onDownload}
      >
        {t("fileViewerDownloadFile" as never)}
      </button>
    </div>
  );
}

function TablePreview({ data }: { data: ParsedPreview }) {
  const { t } = useI18n();
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = data.sheets[activeSheet] ?? data.sheets[0];
  if (!sheet) return null;
  const columnCount = sheet.rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    0,
  );
  return (
    <div className="file-viewer-table-wrap">
      {data.sheets.length > 1 && (
        <div className="sheet-tabs">
          {data.sheets.map((candidate, index) => (
            <button
              key={candidate.name}
              type="button"
              className={`sheet-tab${index === activeSheet ? " active" : ""}`}
              onClick={() => setActiveSheet(index)}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}
      <div className="table-scroll">
        <table className="preview-table">
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows in a read-only preview
              <tr key={rowIndex}>
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional cells in a read-only preview
                  <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated && (
        <div className="table-truncated-note">
          {t("fileViewerTruncatedRows" as never, {
            shown: sheet.rows.length,
            total: sheet.totalRows,
          })}
        </div>
      )}
    </div>
  );
}

// Icons
function CopyTitleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
      <path d="M7.25 8h4.5M9.5 8v3.75" />
    </svg>
  );
}

function CopyPathIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
      <path d="M11.25 7.75 8.25 12.25" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}

function CopyFailedIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v9M4 8l4 4 4-4M2 14h12" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4M9 2h5v5M6 10l8-8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 2v3H2M14 5h-3V2M11 14v-3h3M2 11h3v3" />
    </svg>
  );
}
