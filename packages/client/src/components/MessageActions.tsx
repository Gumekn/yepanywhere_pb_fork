import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";

interface MessageActionsProps {
  /** ISO timestamp string from the source message; shown on hover. */
  timestamp?: string;
  /** Plain-text payload to copy. When omitted, the copy button is hidden. */
  copyText?: string;
  /**
   * When provided, show an "edit" button. Used on user messages to rewind the
   * conversation: forks the session up to this message and prefills the input.
   */
  onEdit?: () => void;
}

/**
 * Hover-revealed action row for a chat bubble or assistant turn:
 *  - timestamp (formatted as a short local time)
 *  - copy-to-clipboard button
 *
 * Visibility is driven by the parent's `:hover` / `:focus-within` styles in
 * index.css. On touch devices the actions are kept faintly visible (see
 * `@media (hover: none)` block) since `:hover` never reliably triggers.
 */
export function MessageActions({
  timestamp,
  copyText,
  onEdit,
}: MessageActionsProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  // Reset the "Copied!" pulse after a short window.
  useEffect(() => {
    if (!copied) return;
    const handle = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(handle);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    if (!copyText) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText);
      } else {
        // Legacy fallback for non-secure contexts (HTTP without TLS).
        const textarea = document.createElement("textarea");
        textarea.value = copyText;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
    } catch {
      // Ignore — failures here are typically permissions-related and we
      // don't want to surface them noisily inside a chat bubble.
    }
  }, [copyText]);

  if (!timestamp && !copyText && !onEdit) return null;

  return (
    <span
      className={`message-actions${copied ? " is-active" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {timestamp && (
        <time
          className="message-actions-time"
          dateTime={timestamp}
          title={formatFullTimestamp(timestamp)}
        >
          {formatShortTime(timestamp)}
        </time>
      )}
      {onEdit && (
        <button
          type="button"
          className="message-actions-edit"
          onClick={onEdit}
          aria-label={t("messageActionEdit")}
          title={t("messageActionEdit")}
        >
          <EditIcon />
        </button>
      )}
      {copyText && (
        <button
          type="button"
          className={`message-actions-copy${copied ? " is-copied" : ""}`}
          onClick={handleCopy}
          aria-label={
            copied ? t("messageActionCopied") : t("messageActionCopy")
          }
          title={copied ? t("messageActionCopied") : t("messageActionCopy")}
        >
          {copied ? <CopiedIcon /> : <CopyIcon />}
        </button>
      )}
    </span>
  );
}

function EditIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
