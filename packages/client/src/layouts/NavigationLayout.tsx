import { type RefObject, useEffect, useRef, useState } from "react";
import { Outlet, useOutletContext, useParams } from "react-router-dom";
import { Sidebar } from "../components/Sidebar";
import { useMobileViewport } from "../hooks/useMobileViewport";
import { setRecentProjectId } from "../hooks/useRecentProject";
import { useSidebarPreference } from "../hooks/useSidebarPreference";
import { useSidebarWidth } from "../hooks/useSidebarWidth";
import { useViewportWidth } from "../hooks/useViewportWidth";
import type { CurlPageDraft } from "../lib/curlDraft";

export interface NavigationLayoutContext {
  /** Open the mobile sidebar */
  openSidebar: () => void;
  /** Whether we're in desktop mode (wide screen) */
  isWideScreen: boolean;
  /** Keep request edits across sidebar navigation, without persisting API keys in the browser. */
  curlDraft?: RefObject<CurlPageDraft | undefined>;
}

/**
 * Shared layout for all pages that need a sidebar.
 * Renders the Sidebar once so it persists across route changes.
 */
export function NavigationLayout() {
  const curlDraft = useRef<CurlPageDraft | undefined>(undefined);
  // Extract sessionId from URL for highlighting in sidebar (works for session pages)
  const { sessionId, projectId } = useParams<{
    sessionId?: string;
    projectId?: string;
  }>();
  // Project history belongs to navigation, not to the retired floating button.
  useEffect(() => {
    if (projectId) setRecentProjectId(projectId);
  }, [projectId]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { isExpanded, toggleExpanded } = useSidebarPreference();
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    isResizing,
    setIsResizing,
    canShowDesktop,
    canShowExpanded,
  } = useSidebarWidth();
  const viewportWidth = useViewportWidth();

  // Desktop mode as long as collapsed sidebar fits
  const isWideScreen = canShowDesktop(viewportWidth);
  useMobileViewport(!isWideScreen);
  // Auto-collapse if viewport too narrow for expanded sidebar, or if user prefers collapsed
  const effectivelyCollapsed = !isExpanded || !canShowExpanded(viewportWidth);

  // Close mobile sidebar overlay when viewport becomes wide enough for expanded desktop sidebar
  // This prevents having both sidebars visible after window resize/device rotation
  // Only auto-close when desktop sidebar is actually visible (isWideScreen)
  useEffect(() => {
    if (sidebarOpen && isWideScreen && canShowExpanded(viewportWidth)) {
      setSidebarOpen(false);
    }
  }, [sidebarOpen, isWideScreen, viewportWidth, canShowExpanded]);

  // Smart toggle: if viewport can support expanded, toggle preference; otherwise open overlay
  const handleToggleExpanded = () => {
    if (canShowExpanded(viewportWidth)) {
      toggleExpanded();
    } else {
      // Viewport too narrow for expanded sidebar - open mobile-style overlay instead
      setSidebarOpen(true);
    }
  };

  const context: NavigationLayoutContext = {
    openSidebar: () => setSidebarOpen(true),
    isWideScreen,
    curlDraft,
  };

  // CSS variable for sidebar width
  const containerStyle = isWideScreen
    ? ({ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={`session-page ${isWideScreen ? "desktop-layout" : ""} ${isResizing ? "resizing" : ""}`}
      style={containerStyle}
    >
      {/* Desktop sidebar - always visible on wide screens */}
      {isWideScreen && (
        <aside
          className={`sidebar-desktop ${effectivelyCollapsed ? "sidebar-collapsed" : ""} ${isResizing ? "resizing" : ""}`}
          style={{ width: effectivelyCollapsed ? undefined : sidebarWidth }}
        >
          <Sidebar
            isOpen={true}
            onClose={() => {}}
            onNavigate={() => {}}
            currentSessionId={sessionId}
            isDesktop={true}
            isCollapsed={effectivelyCollapsed}
            onToggleExpanded={handleToggleExpanded}
            sidebarWidth={sidebarWidth}
            onResizeStart={() => setIsResizing(true)}
            onResize={setSidebarWidth}
            onResizeEnd={() => setIsResizing(false)}
          />
        </aside>
      )}

      {/* Mobile sidebar - modal overlay (also used for constrained desktop overlay) */}
      {sidebarOpen && (
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNavigate={() => setSidebarOpen(false)}
          currentSessionId={sessionId}
        />
      )}

      {/* Child route content */}
      <Outlet context={context} />
    </div>
  );
}

/**
 * Hook for child routes to access the shared navigation layout context.
 */
export function useNavigationLayout(): NavigationLayoutContext {
  return useOutletContext<NavigationLayoutContext>();
}
