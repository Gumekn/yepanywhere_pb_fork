import type { ResizablePanel } from "../../hooks/useResizablePanel";

/** Vertical drag handle on the left edge of a right-docked panel. */
export function PanelResizeHandle({
  panel,
  label,
  hint,
}: {
  panel: ResizablePanel;
  label: string;
  hint: string;
}) {
  return (
    <div
      className={`panel-resize-handle${panel.isResizing ? " active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={panel.min}
      aria-valuemax={panel.max}
      aria-valuenow={panel.width}
      tabIndex={0}
      title={hint}
      onPointerDown={panel.onPointerDown}
      onPointerMove={panel.onPointerMove}
      onPointerUp={panel.onPointerUp}
      onPointerCancel={panel.onPointerUp}
      onDoubleClick={panel.reset}
      onKeyDown={panel.onKeyDown}
    />
  );
}
