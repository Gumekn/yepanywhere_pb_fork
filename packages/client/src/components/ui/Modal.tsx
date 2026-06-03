import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /**
   * Show a "back" button on the left side of the header. When provided, the
   * label is shown next to a left-arrow icon and clicking it triggers
   * onClose. Use this on mobile-facing modals so users have an obvious
   * way to dismiss the modal — the right-side × button is small and easily
   * missed on touch.
   */
  backLabel?: string;
}

/**
 * Reusable modal component with overlay, header, and scrollable content area.
 * Renders via portal to avoid event bubbling issues.
 * Closes on Escape key, clicking the overlay, or the browser back button
 * (including Android swipe-back, which triggers popstate).
 */
export function Modal({ title, children, onClose, backLabel }: ModalProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Keep a stable ref to onClose so the history-binding effect can fire once
  // per mount without re-running every time the parent re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Push a history entry so the browser back button (and Android edge-swipe
  // back gesture, which fires popstate) closes the modal instead of
  // navigating away from the underlying page. Without this, opening a modal
  // on the session page and swiping back drops the user on the home screen
  // — confusing, because they expected to return to the conversation.
  useEffect(() => {
    window.history.pushState({ yepModalOpen: true }, "");
    // Tracks whether the marker we pushed is still on top of the history
    // stack. Becomes false once popstate fires (browser already popped it).
    let markerOnStack = true;

    const handlePopState = () => {
      markerOnStack = false;
      onCloseRef.current();
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (markerOnStack) {
        // The user closed the modal some other way (× / Escape / overlay /
        // backLabel button). Pop the marker we pushed so we don't leave a
        // dead entry on the history stack. Listener is already removed, so
        // this won't recurse.
        window.history.back();
      }
    };
  }, []);

  // Focus the close button on mount for accessibility. preventScroll keeps
  // the viewport stable: without it the WebView may scroll the focused
  // button into view, which can interact badly with the soft keyboard
  // closing right after a click on the input toolbar.
  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Only close if clicking directly on the overlay, not its children
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const handleModalClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent overlay click handler
    e.stopPropagation();
  };

  const modalContent = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally, click is for overlay dismiss
    <div
      className="modal-overlay"
      onClick={handleOverlayClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={handleModalClick}
      >
        <div
          className={`modal-header${backLabel ? " modal-header--with-back" : ""}`}
        >
          {backLabel && (
            <button
              type="button"
              className="modal-back"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
              aria-label={backLabel}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span className="modal-back-label">{backLabel}</span>
            </button>
          )}
          <span className="modal-title">{title}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="modal-close"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            aria-label={t("modalClose")}
          >
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}
