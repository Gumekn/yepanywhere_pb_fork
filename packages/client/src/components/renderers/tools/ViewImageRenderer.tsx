import { useState } from "react";
import { api } from "../../../api/client";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useFetchedImage } from "../../../hooks/useRemoteImage";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer } from "./types";

interface ViewImageInput {
  path?: string;
  url?: string;
  title?: string;
  status?: string;
  revised_prompt?: string;
  result?: string;
}

type ImageSource =
  | { type: "local"; path: string; label: string }
  | { type: "direct"; url: string; label: string };

interface ImageSessionMetadata {
  projectId: string;
  projectPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getImageInput(input: unknown, result?: unknown): ViewImageInput {
  const inputRecord = isRecord(input) ? input : {};
  const resultRecord = isRecord(result) ? result : {};
  return {
    path: getString(inputRecord.path) ?? getString(resultRecord.path),
    url: getString(inputRecord.url) ?? getString(resultRecord.url),
    title: getString(inputRecord.title),
    status: getString(inputRecord.status) ?? getString(resultRecord.status),
    revised_prompt:
      getString(inputRecord.revised_prompt) ??
      getString(inputRecord.revisedPrompt) ??
      getString(resultRecord.revised_prompt) ??
      getString(resultRecord.revisedPrompt),
    result: getString(inputRecord.result) ?? getString(resultRecord.result),
  };
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function getUrlName(url: string): string {
  if (url.startsWith("data:")) {
    return "Generated image";
  }

  try {
    const parsed = new URL(url);
    const name = getFileName(parsed.pathname);
    return name || parsed.hostname || "Generated image";
  } catch {
    return "Generated image";
  }
}

function getProjectRelativePath(
  path: string,
  projectPath: string | null,
): string | null {
  if (!projectPath) return null;
  const normalizedProjectPath = projectPath.replace(/\/+$/, "");
  if (!normalizedProjectPath) return null;
  if (!path.startsWith(`${normalizedProjectPath}/`)) return null;
  return path.slice(normalizedProjectPath.length + 1);
}

function getImageSource(
  input: ViewImageInput,
  metadata?: ImageSessionMetadata | null,
): ImageSource | null {
  if (input.path) {
    const projectRelativePath = getProjectRelativePath(
      input.path,
      metadata?.projectPath ?? null,
    );
    if (projectRelativePath && metadata?.projectId) {
      return {
        type: "direct",
        url: api.getFileRawUrl(metadata.projectId, projectRelativePath),
        label: input.title ?? getFileName(input.path),
      };
    }

    return {
      type: "local",
      path: input.path,
      label: input.title ?? getFileName(input.path),
    };
  }

  if (input.url) {
    return {
      type: "direct",
      url: input.url,
      label: input.title ?? getUrlName(input.url),
    };
  }

  return null;
}

/**
 * Modal content that fetches the image only when mounted (i.e. when modal opens).
 */
function ViewImageModalContent({
  source,
  alt,
}: {
  source: ImageSource;
  alt: string;
}) {
  const apiPath =
    source.type === "local"
      ? `/api/local-image?path=${encodeURIComponent(source.path)}`
      : null;
  const { url, loading, error } = useFetchedImage(apiPath);

  if (source.type === "direct") {
    return (
      <div className="read-image-result">
        <img
          className="read-image"
          src={source.url}
          alt={alt}
          style={{ maxWidth: "100%" }}
        />
      </div>
    );
  }

  if (loading) {
    return <div className="viewimage-loading">Loading image...</div>;
  }

  if (error || !url) {
    return (
      <div className="viewimage-error">{error ?? "Failed to load image"}</div>
    );
  }

  return (
    <div className="read-image-result">
      <img
        className="read-image"
        src={url}
        alt={alt}
        style={{ maxWidth: "100%" }}
      />
    </div>
  );
}

/**
 * Clickable filename button that opens a modal to view the image.
 * Does NOT fetch anything until the modal is opened.
 */
function ViewImageButton({
  label,
  className,
  onClick,
}: {
  label: string;
  className: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button type="button" className={className} onClick={onClick}>
      {label}
      <span className="file-line-count-inline">(image)</span>
    </button>
  );
}

/**
 * Shared component: clickable filename + lazy-loading modal.
 */
function ViewImageClickable({
  input,
  buttonClass,
  stopPropagation,
}: {
  input: ViewImageInput;
  buttonClass: string;
  stopPropagation?: boolean;
}) {
  const metadata = useOptionalSessionMetadata();
  const source = getImageSource(input, metadata);
  const [showModal, setShowModal] = useState(false);

  if (!source) {
    return <ViewImageUnavailable input={input} />;
  }

  return (
    <>
      <ViewImageButton
        label={source.label}
        className={buttonClass}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          setShowModal(true);
        }}
      />
      {showModal && (
        <Modal title={source.label} onClose={() => setShowModal(false)}>
          <ViewImageModalContent source={source} alt={source.label} />
        </Modal>
      )}
    </>
  );
}

function ViewImageUnavailable({ input }: { input: ViewImageInput }) {
  const text =
    input.result ?? input.status ?? "No image preview source was recorded";
  return <div className="viewimage-error">{text}</div>;
}

export const viewImageRenderer: ToolRenderer<ViewImageInput, unknown> = {
  tool: "ViewImage",
  displayName: "View Image",

  renderToolUse(input, _context) {
    const imageInput = getImageInput(input);
    const source = getImageSource(imageInput);
    return (
      <div className="read-image-result">
        {source ? (
          <ViewImageClickable
            input={imageInput}
            buttonClass="file-link-button"
          />
        ) : (
          <ViewImageUnavailable input={imageInput} />
        )}
      </div>
    );
  },

  renderToolResult(result, _isError, _context, input) {
    const imageInput = getImageInput(input, result);
    const source = getImageSource(imageInput);
    return (
      <div className="read-image-result">
        {source ? (
          <ViewImageClickable
            input={imageInput}
            buttonClass="file-link-button"
          />
        ) : (
          <ViewImageUnavailable input={imageInput} />
        )}
      </div>
    );
  },

  getUseSummary(input) {
    const imageInput = getImageInput(input);
    const source = getImageSource(imageInput);
    return source?.label ?? imageInput.status ?? "Image";
  },

  getResultSummary(_result, isError) {
    return isError ? "Error" : "Image loaded";
  },

  renderInteractiveSummary(input, _result, _isError, _context) {
    const imageInput = getImageInput(input);
    const source = getImageSource(imageInput);
    if (!source) {
      return null;
    }

    return (
      <ViewImageClickable
        input={imageInput}
        buttonClass="file-link-inline"
        stopPropagation
      />
    );
  },
};
