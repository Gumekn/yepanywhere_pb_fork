import { useElapsedLabel } from "../../hooks/useElapsedLabel";
import { useOptionalI18n } from "../../i18n";
import { formatElapsed } from "../../lib/formatElapsed";

export function ToolDuration({
  timestamp,
  completedAt,
  durationMs,
  running,
  testId = "tool-call-duration",
}: {
  timestamp?: string;
  completedAt?: string;
  durationMs?: number;
  running: boolean;
  testId?: string;
}) {
  const i18n = useOptionalI18n();
  const live = useElapsedLabel(timestamp, running);
  // Completed history must not use the live timer's age cutoff or Date.now().
  const start = Date.parse(timestamp ?? "");
  const end = Date.parse(completedAt ?? "");
  const nativeDuration =
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs >= 0;
  const duration = nativeDuration ? durationMs : end - start;
  const label = running
    ? live?.label
    : Number.isFinite(duration) && (duration > 0 || nativeDuration)
      ? duration < 1000
        ? "<1s"
        : formatElapsed(duration)
      : undefined;
  if (!label) return null;
  const time = Number.isFinite(start)
    ? new Date(start).toLocaleTimeString()
    : "";
  const title = running
    ? (i18n?.t("sessionDisplayStepElapsed", { elapsed: label, time }) ??
      `Running for ${label} · started at ${time}`)
    : nativeDuration
      ? (i18n?.t("sessionDisplayStepNativeDuration", { elapsed: label }) ??
        `Tool duration: ${label}`)
      : (i18n?.t("sessionDisplayStepDuration", { elapsed: label, time }) ??
        `Call to result: ${label} · started at ${time}`);
  return (
    <span
      className="display-step-elapsed"
      data-running={running || undefined}
      data-testid={testId}
      title={title}
      aria-label={title}
    >
      {label}
    </span>
  );
}
