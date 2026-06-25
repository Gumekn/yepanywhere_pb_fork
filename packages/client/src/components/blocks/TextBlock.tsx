import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { appPath } from "../../lib/apiPath";
import { getSelectionAwareCopyText } from "../../lib/clipboard";
import { splitTextWithFilePaths } from "../../lib/filePathDetection";
import { FileViewerModal } from "../FilePathLink";
import {
  LocalMediaModal,
  extractPathFromLocalImageUrl,
  useLocalMediaClick,
} from "../LocalMediaModal";

interface Props {
  text: string;
  isStreaming?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
}

function getProjectRelativePath(
  filePath: string,
  projectPath: string | null | undefined,
): string | null {
  const root = projectPath?.replace(/\/+$/, "");
  if (!root) return null;
  if (!filePath.startsWith(`${root}/`)) return null;
  return filePath.slice(root.length + 1);
}

function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

function getExtension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function isLocalMediaPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  return MEDIA_EXTENSIONS.has(getExtension(path));
}

function localMediaApiPath(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path)}`;
}

function renderPlainTextWithLocalMediaLinks(text: string): React.ReactNode {
  const segments = splitTextWithFilePaths(text);

  return segments.map((segment) => {
    if (segment.type === "text") {
      return segment.content;
    }

    const path = segment.detected.filePath;
    if (!isLocalMediaPath(path)) {
      return segment.detected.match;
    }

    const ext = getExtension(path);
    const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
    const typeLabel = mediaType;

    return (
      <a
        key={`${path}-${segment.detected.startIndex}`}
        href={localMediaApiPath(path)}
        className="local-media-link"
        data-media-type={mediaType}
      >
        {segment.detected.match}
        <span className="local-media-type">({typeLabel})</span>
      </a>
    );
  });
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  augmentHtml,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [fileModal, setFileModal] = useState<{ filePath: string } | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  const sessionMetadata = useOptionalSessionMetadata();

  // Streaming markdown hook for server-rendered content
  const streamingMarkdown = useStreamingMarkdown();
  const streamingContext = useStreamingMarkdownContext();

  // Track whether we're actively using streaming markdown (received at least one augment)
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  // Register with context when streaming and context is available
  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      // Reset streaming state when not streaming
      // (HTML is captured to markdownAugments before component remounts)
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    // Register handlers with the context
    const unregister = streamingContext.registerStreamingHandler({
      onAugment: (augment) => {
        // Mark that we're using streaming content on first augment
        setUseStreamingContent(true);
        streamingMarkdown.onAugment(augment);
      },
      onPending: streamingMarkdown.onPending,
      onStreamEnd: streamingMarkdown.onStreamEnd,
      captureHtml: streamingMarkdown.captureHtml,
    });

    return unregister;
  }, [isStreaming, streamingContext, streamingMarkdown]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        getSelectionAwareCopyText(text, blockRef.current),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }, [text]);

  const {
    modal,
    handleClick: handleLocalMediaClick,
    closeModal,
  } = useLocalMediaClick();

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (handleLocalMediaClick(e)) return;

      const target = (e.target as HTMLElement).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      const absoluteFilePath = extractPathFromLocalImageUrl(href);
      if (!absoluteFilePath) return;

      const relativePath = getProjectRelativePath(
        absoluteFilePath,
        sessionMetadata?.projectPath,
      );
      if (!relativePath || !sessionMetadata?.projectId) {
        if (href.startsWith("/api/")) {
          e.preventDefault();
          e.stopPropagation();
          window.location.assign(appPath(href));
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (isModifiedClick(e)) {
        window.open(
          appPath(
            `/projects/${sessionMetadata.projectId}/file?path=${encodeURIComponent(relativePath)}`,
          ),
          "_blank",
        );
        return;
      }

      setFileModal({ filePath: relativePath });
    },
    [handleLocalMediaClick, sessionMetadata],
  );

  const showStreamingContent = isStreaming && useStreamingContent;

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler intercepts local media links only
    <div
      ref={blockRef}
      className={`text-block timeline-item${isStreaming ? " streaming" : ""}`}
      onClick={handleClick}
    >
      <button
        type="button"
        className={`text-block-copy ${copied ? "copied" : ""}`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy markdown"}
        aria-label={copied ? "Copied!" : "Copy markdown"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>

      {/* Always render streaming elements when streaming so refs are ready for augments */}
      {renderStreamingContainer && (
        <div style={showStreamingContent ? undefined : { display: "none" }}>
          <div
            ref={streamingMarkdown.containerRef}
            className="streaming-blocks"
          />
          <span
            ref={streamingMarkdown.pendingRef}
            className="streaming-pending"
          />
        </div>
      )}

      {/* Show fallback content when not actively streaming */}
      {!showStreamingContent &&
        (augmentHtml ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
          <div dangerouslySetInnerHTML={{ __html: augmentHtml }} />
        ) : (
          // Plain text fallback (no server augment available)
          <p>{renderPlainTextWithLocalMediaLinks(text)}</p>
        ))}
      {modal && (
        <LocalMediaModal
          path={modal.path}
          mediaType={modal.mediaType}
          onClose={closeModal}
        />
      )}
      {fileModal &&
        sessionMetadata?.projectId &&
        createPortal(
          <FileViewerModal
            projectId={sessionMetadata.projectId}
            filePath={fileModal.filePath}
            onClose={() => setFileModal(null)}
          />,
          document.body,
        )}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
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
      width="14"
      height="14"
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
