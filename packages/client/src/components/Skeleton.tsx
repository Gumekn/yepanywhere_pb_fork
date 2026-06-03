/**
 * Skeleton primitives for loading states.
 *
 * Renders a muted, pulsing placeholder that approximates the shape of the
 * real content. Combined with the content-fade-in animation on the real
 * element, this gives a smooth swap from loading state → loaded state with
 * no layout shift or flash of empty content.
 *
 * Two layers:
 *   <Skeleton />                  — primitive box you can size with props
 *   <SessionListItemSkeleton />   — pre-composed shape for a session card
 *   <ProjectCardSkeleton />       — pre-composed shape for a project card
 */

interface SkeletonProps {
  /** CSS width (e.g. "60%", "120px"). Defaults to 100%. */
  width?: string | number;
  /** CSS height (e.g. "1em", "16px"). Defaults to 1em. */
  height?: string | number;
  /** Optional border radius override (defaults to var(--radius-sm)). */
  radius?: string;
  /** Optional className for layout adjustments. */
  className?: string;
}

export function Skeleton({
  width = "100%",
  height = "1em",
  radius,
  className,
}: SkeletonProps) {
  return (
    <span
      className={`skeleton ${className ?? ""}`}
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
        borderRadius: radius,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * Placeholder shaped like a session card in the list view. Two-line layout:
 * title + meta row. Used while the global sessions / inbox lists load.
 */
export function SessionListItemSkeleton() {
  return (
    <li className="session-list-item session-list-item--card skeleton-item">
      <div className="session-list-item__link" aria-hidden="true">
        <div className="skeleton-row skeleton-row--title">
          <Skeleton width="55%" height="1.05em" />
        </div>
        <div className="skeleton-row skeleton-row--meta">
          <Skeleton width="70px" height="0.9em" />
          <Skeleton width="50px" height="0.9em" />
          <Skeleton width="60px" height="0.9em" radius="999px" />
        </div>
      </div>
    </li>
  );
}

/**
 * Placeholder shaped like a project card. Mirrors ProjectCard's two-row
 * header (name + new-session button) and meta row (path + stats).
 */
export function ProjectCardSkeleton() {
  return (
    <li className="project-card skeleton-item">
      <div className="project-card__link" aria-hidden="true">
        <div className="project-card__header">
          <Skeleton width="45%" height="1.1em" />
          <Skeleton width="28px" height="28px" radius="6px" />
        </div>
        <div className="project-card__meta">
          <Skeleton width="80%" height="0.9em" />
          <div className="skeleton-row skeleton-row--meta">
            <Skeleton width="60px" height="0.85em" />
            <Skeleton width="40px" height="0.85em" />
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * A small fixed-count list of session skeletons used as the "loading" state
 * for the global sessions / inbox lists.
 */
export function SessionListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="session-list" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
        <SessionListItemSkeleton key={`sk-${i}`} />
      ))}
    </ul>
  );
}

/**
 * Skeleton list of project cards used as the "loading" state for ProjectsPage.
 */
export function ProjectListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <ul className="project-list-cards" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
        <ProjectCardSkeleton key={`sk-${i}`} />
      ))}
    </ul>
  );
}

/**
 * Generic block-shaped skeleton: a row of placeholder cards inside a flex
 * column container. Used by AgentsPage / GitStatusPage where the real
 * content is a vertical stack of cards.
 */
export function CardListSkeleton({
  count = 3,
  height = 72,
}: { count?: number; height?: number }) {
  return (
    <div className="card-list-skeleton" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
          key={`sk-${i}`}
          height={height}
          radius="8px"
          className="skeleton-block"
        />
      ))}
    </div>
  );
}

/**
 * Chat-shaped skeleton for SessionPage. Alternates left (assistant-style)
 * and right (user-bubble-style) placeholders of varying widths so the
 * loading state reads as "a chat is here, just not loaded yet."
 */
export function SessionMessagesSkeleton() {
  // Pattern designed to feel like a real conversation: short user message,
  // longer assistant reply, short user follow-up, etc.
  const rows: { side: "left" | "right"; width: string; lines: number }[] = [
    { side: "right", width: "55%", lines: 1 },
    { side: "left", width: "85%", lines: 3 },
    { side: "right", width: "40%", lines: 1 },
    { side: "left", width: "75%", lines: 2 },
    { side: "right", width: "60%", lines: 1 },
  ];

  return (
    <div
      className="session-messages-skeleton"
      aria-busy="true"
      aria-live="polite"
    >
      {rows.map((row, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
          key={`sk-${i}`}
          className={`session-messages-skeleton__row session-messages-skeleton__row--${row.side}`}
        >
          <div
            className="session-messages-skeleton__bubble"
            style={{ width: row.width }}
          >
            {Array.from({ length: row.lines }, (_, li) => (
              <Skeleton
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                key={`sk-line-${li}`}
                height="0.85em"
                width={li === row.lines - 1 ? "70%" : "100%"}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
