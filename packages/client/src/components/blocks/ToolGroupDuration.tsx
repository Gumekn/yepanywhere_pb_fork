import type { SessionDisplaySegment } from "@yep-anywhere/shared";
import { useI18n } from "../../i18n";
import { formatElapsed } from "../../lib/formatElapsed";

/** Counts and timing come from the full index, even while details are closed. */
export function ToolGroupDuration({
  group,
}: {
  group: Extract<SessionDisplaySegment, { type: "tool_group" }>;
}) {
  const { t } = useI18n();
  const known = group.timedCount ?? 0;
  const duration = group.durationMs;
  const hasDuration =
    known > 0 &&
    duration !== undefined &&
    Number.isFinite(duration) &&
    duration >= 0;
  const elapsed =
    duration !== undefined && duration < 1000
      ? "<1s"
      : formatElapsed(duration ?? 0);
  const label = hasDuration
    ? t(
        known === group.count
          ? "sessionToolGroupDuration"
          : "sessionToolGroupPartialDuration",
        { elapsed },
      )
    : t(
        group.status === "running"
          ? "sessionToolGroupTiming"
          : "sessionToolGroupDurationUnknown",
      );
  return (
    <span
      className="display-tool-group-duration"
      data-testid="tool-group-duration"
      title={t("sessionToolGroupDurationHint", { known, total: group.count })}
    >
      {label}
    </span>
  );
}
