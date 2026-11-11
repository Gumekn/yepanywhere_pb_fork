import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useViewportWidth } from "./useViewportWidth";

/** Keep at least this much width for the conversation beside a panel. */
export const MIN_SESSION_WIDTH = 360;
const ABSOLUTE_MIN_PANEL_WIDTH = 240;
const RESIZE_KEYBOARD_STEP = 24;

export interface ResizablePanelLayout {
  /** Widest the panel may get while the rest of its row keeps its minimum. */
  availableWidth: number;
  /** Right edge the panel is anchored to; drags are measured from here. */
  right: number;
}

export interface ResizablePanelOptions {
  /** localStorage key; the chosen width is stored as a viewport ratio. */
  storageKey: string;
  /** Width before the user resizes, and after a reset. */
  defaultWidth: (viewportWidth: number) => number;
  minWidth: number;
  /** Upper bound as a fraction of the viewport. */
  maxRatio: number;
  /** Current row geometry; `null` falls back to the viewport. */
  getLayout: () => ResizablePanelLayout | null;
  /** Docked layouts only: overlay/full-screen variants keep their own width. */
  enabled: boolean;
}

export interface ResizablePanel {
  width: number;
  min: number;
  max: number;
  isResizing: boolean;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onPointerMove(event: PointerEvent<HTMLElement>): void;
  onPointerUp(event: PointerEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  reset(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadRatio(storageKey: string, maxRatio: number): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? clamp(parsed, 0.1, maxRatio) : null;
  } catch {
    return null;
  }
}

function saveRatio(storageKey: string, ratio: number | null): void {
  try {
    if (ratio === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, ratio.toFixed(4));
  } catch {
    /* Storage may be unavailable; the width still applies to this view. */
  }
}

/**
 * Width state and pointer/keyboard handling for a panel docked to the right
 * of the conversation, shared by file details and the side conversation.
 * Drag the handle, use arrow keys, or double-click/Home to reset.
 */
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxRatio,
  getLayout,
  enabled,
}: ResizablePanelOptions): ResizablePanel {
  const viewportWidth = useViewportWidth();
  const [ratio, setRatio] = useState(() => loadRatio(storageKey, maxRatio));
  const ratioRef = useRef(ratio);
  const [isResizing, setIsResizing] = useState(false);
  const pointerIdRef = useRef<number | null>(null);

  const layout = enabled ? getLayout() : null;
  const availableWidth = Math.max(
    ABSOLUTE_MIN_PANEL_WIDTH,
    layout?.availableWidth ?? viewportWidth - MIN_SESSION_WIDTH,
  );
  const min = Math.min(minWidth, availableWidth);
  const max = Math.max(min, Math.min(viewportWidth * maxRatio, availableWidth));
  const width = Math.round(
    clamp(
      ratio === null ? defaultWidth(viewportWidth) : viewportWidth * ratio,
      min,
      max,
    ),
  );

  const update = useCallback(
    (requested: number, persist: boolean) => {
      const next = clamp(requested, min, max) / Math.max(viewportWidth, 1);
      ratioRef.current = next;
      setRatio(next);
      if (persist) saveRatio(storageKey, next);
    },
    [min, max, viewportWidth, storageKey],
  );

  const reset = useCallback(() => {
    ratioRef.current = null;
    setRatio(null);
    saveRatio(storageKey, null);
  }, [storageKey]);

  useEffect(() => {
    if (!isResizing) return;
    document.body.classList.add("panel-resizing");
    return () => document.body.classList.remove("panel-resizing");
  }, [isResizing]);

  return {
    width,
    min,
    max,
    isResizing,
    reset,
    onPointerDown(event) {
      if (!enabled || (event.pointerType === "mouse" && event.button !== 0))
        return;
      event.preventDefault();
      event.stopPropagation();
      pointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setIsResizing(true);
    },
    onPointerMove(event) {
      if (pointerIdRef.current !== event.pointerId) return;
      if (!Number.isFinite(event.clientX)) return;
      event.preventDefault();
      const right = getLayout()?.right ?? 0;
      update((right > 0 ? right : viewportWidth) - event.clientX, false);
    },
    onPointerUp(event) {
      if (pointerIdRef.current !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      pointerIdRef.current = null;
      setIsResizing(false);
      saveRatio(storageKey, ratioRef.current);
    },
    onKeyDown(event) {
      if (event.key === "Home") {
        event.preventDefault();
        reset();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey
        ? RESIZE_KEYBOARD_STEP * 3
        : RESIZE_KEYBOARD_STEP;
      update(width + (event.key === "ArrowLeft" ? step : -step), true);
    },
  };
}
