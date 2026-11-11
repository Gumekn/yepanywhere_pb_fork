import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  MIN_SESSION_WIDTH,
  useResizablePanel,
} from "../../hooks/useResizablePanel";
import { DESKTOP_BREAKPOINT } from "../../hooks/useSidebarWidth";
import { useI18n } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { PanelResizeHandle } from "./PanelResizeHandle";

const DESKTOP_DETAIL_PANEL_QUERY = `(min-width: ${DESKTOP_BREAKPOINT}px)`;
const DETAIL_PANEL_OPEN_EVENT = "yep:detail-panel-open";
const DEFAULT_DETAIL_PANEL_RATIO = 0.4;
const MIN_DETAIL_PANEL_WIDTH = 320;
const MAX_DETAIL_PANEL_RATIO = 0.72;

// A file opened from a detail transcript belongs above that panel. React
// context follows portals, so its parent stays known even when both use body.
const ParentDetailPanelContext = createContext<(() => () => void) | null>(null);

interface DetailPanelProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /**
   * FileViewer owns its richer header and action bar, so it can ask the
   * surrounding panel to provide layout only.
   */
  hideHeader?: boolean;
  /** Remove the default content padding for a child that owns its chrome. */
  flush?: boolean;
  /** Accessible name used when the visual header is hidden. */
  ariaLabel?: string;
}

interface DetailPanelOpenEventDetail {
  panelId: string;
}

const defaultDetailPanelWidth = (viewportWidth: number) =>
  viewportWidth * DEFAULT_DETAIL_PANEL_RATIO;

/**
 * File/report detail surface.
 *
 * Inside the desktop navigation layout it is portalled directly into the
 * session flex row, making it a real right-hand sibling of the conversation.
 * On smaller viewports (and outside that layout) it retains the familiar
 * modal/full-screen behaviour.
 */
export function DetailPanel({
  title,
  children,
  onClose,
  hideHeader = false,
  flush = false,
  ariaLabel,
}: DetailPanelProps) {
  const { t } = useI18n();
  const parentPanel = useContext(ParentDetailPanelContext);
  const nestedPanelsRef = useRef(0);
  const registerNestedPanel = useCallback(() => {
    nestedPanelsRef.current += 1;
    return () => {
      nestedPanelsRef.current -= 1;
    };
  }, []);
  useLayoutEffect(() => parentPanel?.(), [parentPanel]);
  const panelId = useId();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const desktopViewport = useMediaQuery(DESKTOP_DETAIL_PANEL_QUERY);
  const layoutRoot =
    !parentPanel && desktopViewport && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".session-page")
      : null;
  const isDocked = layoutRoot !== null;
  const portalTarget = layoutRoot ?? document.body;
  const resize = useResizablePanel({
    storageKey: UI_KEYS.detailPanelWidthRatio,
    defaultWidth: defaultDetailPanelWidth,
    minWidth: MIN_DETAIL_PANEL_WIDTH,
    maxRatio: MAX_DETAIL_PANEL_RATIO,
    enabled: isDocked,
    getLayout: () => {
      if (!layoutRoot) return null;
      const sidebarWidth =
        layoutRoot
          .querySelector<HTMLElement>(".sidebar-desktop")
          ?.getBoundingClientRect().width ?? 0;
      return {
        availableWidth: window.innerWidth - sidebarWidth - MIN_SESSION_WIDTH,
        right: layoutRoot.getBoundingClientRect().right,
      };
    },
  });

  // Escape closes the detail surface. A fullscreen FileViewer consumes the
  // first Escape itself so users return to the side panel before closing it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented || nestedPanelsRef.current > 0) return;
      if (document.querySelector(".file-viewer-fullscreen")) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // The conversation remains interactive beside a docked panel. Opening a
  // second file therefore replaces the previous file instead of accumulating
  // multiple flex siblings and squeezing the session to zero width.
  useEffect(() => {
    if (!isDocked) return;

    const handleOtherPanelOpen = (event: Event) => {
      const detail = (event as CustomEvent<DetailPanelOpenEventDetail>).detail;
      if (detail?.panelId !== panelId) {
        onCloseRef.current();
      }
    };

    window.addEventListener(DETAIL_PANEL_OPEN_EVENT, handleOtherPanelOpen);
    window.dispatchEvent(
      new CustomEvent<DetailPanelOpenEventDetail>(DETAIL_PANEL_OPEN_EVENT, {
        detail: { panelId },
      }),
    );

    return () => {
      window.removeEventListener(DETAIL_PANEL_OPEN_EVENT, handleOtherPanelOpen);
    };
  }, [isDocked, panelId]);

  // Only the fallback modal locks document scrolling. The desktop app already
  // owns its scroll containers, and the session must remain usable when the
  // panel is docked.
  useEffect(() => {
    if (isDocked) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDocked]);

  // Preserve mobile browser/Android back semantics from the shared Modal.
  useEffect(() => {
    if (isDocked) return;

    window.history.pushState(
      { yepDetailPanelOpen: true, yepDetailPanelId: panelId },
      "",
    );
    let markerOnStack = true;

    const handlePopState = (event: PopStateEvent) => {
      // Closing a nested panel (including its cleanup history.back()) returns
      // to our own marker. Our panel's history entry has not been popped yet.
      if (
        nestedPanelsRef.current > 0 ||
        event.state?.yepDetailPanelId === panelId
      )
        return;
      markerOnStack = false;
      onCloseRef.current();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (markerOnStack && window.history.state?.yepDetailPanelId === panelId) {
        window.history.back();
      }
    };
  }, [isDocked, panelId]);

  useEffect(() => {
    if (!hideHeader) {
      closeButtonRef.current?.focus({ preventScroll: true });
    }
  }, [hideHeader]);

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isDocked && event.target === event.currentTarget) {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    }
  };

  const panel = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled globally; click dismisses only the fallback backdrop
    <div
      className={`modal-overlay detail-panel-host${
        isDocked ? " detail-panel-host--docked" : " detail-panel-host--overlay"
      }${resize.isResizing ? " detail-panel-host--resizing" : ""}`}
      style={
        isDocked
          ? ({
              "--detail-panel-width": `${resize.width}px`,
            } as CSSProperties)
          : undefined
      }
      onClick={handleBackdropClick}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {isDocked && (
        <PanelResizeHandle
          panel={resize}
          label={t("actionResizeDetailPanel")}
          hint={t("actionResizeDetailPanelHint")}
        />
      )}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only isolates the panel from its backdrop */}
      <div
        className={`modal detail-panel${
          hideHeader ? " detail-panel--headerless" : ""
        }`}
        role="dialog"
        aria-modal={isDocked ? undefined : true}
        aria-labelledby={hideHeader ? undefined : titleId}
        aria-label={hideHeader ? ariaLabel : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {!hideHeader && (
          <div className="modal-header detail-panel-header">
            <span id={titleId} className="modal-title detail-panel-title">
              {title}
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              className="modal-close"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
              }}
              aria-label={t("modalClose")}
            >
              ×
            </button>
          </div>
        )}
        <div
          className={`modal-content detail-panel-content${
            flush ? " detail-panel-content--flush" : ""
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );

  return (
    <ParentDetailPanelContext.Provider value={registerNestedPanel}>
      {createPortal(panel, portalTarget)}
    </ParentDetailPanelContext.Provider>
  );
}
