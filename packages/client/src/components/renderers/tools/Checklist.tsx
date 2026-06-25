export type ChecklistStatus = "pending" | "in_progress" | "completed";

export interface ChecklistItem {
  label: string;
  status: ChecklistStatus;
}

interface ChecklistPanelProps {
  title: string;
  items: ChecklistItem[];
  note?: string;
  trailingMessage?: string;
}

export function normalizeChecklistStatus(status: unknown): ChecklistStatus {
  if (typeof status !== "string") {
    return "pending";
  }

  const normalized = status.trim().toLowerCase();
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "active" ||
    normalized === "running"
  ) {
    return "in_progress";
  }
  return "pending";
}

export function getChecklistSummary(items: ChecklistItem[]): string {
  if (items.length === 0) {
    return "No tasks";
  }

  const completed = items.filter((item) => item.status === "completed").length;
  return `${completed}/${items.length} complete`;
}

function getStatusLabel(status: ChecklistStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "in_progress":
      return "In progress";
    default:
      return "Pending";
  }
}

function getStatusClassName(status: ChecklistStatus): string {
  return status === "in_progress" ? "in-progress" : status;
}

export function ChecklistPanel({
  title,
  items,
  note,
  trailingMessage,
}: ChecklistPanelProps) {
  return (
    <div className="task-checklist">
      <div className="task-checklist-header">
        <span className="task-checklist-title">{title}</span>
        <span className="task-checklist-progress">
          {getChecklistSummary(items)}
        </span>
      </div>
      {note && <div className="task-checklist-note">{note}</div>}
      <div className="task-checklist-items">
        {items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            className={`task-checklist-item ${getStatusClassName(item.status)}`}
          >
            <span
              className="task-checklist-marker"
              role="img"
              aria-label={getStatusLabel(item.status)}
              title={getStatusLabel(item.status)}
            />
            <span className="task-checklist-label">{item.label}</span>
          </div>
        ))}
      </div>
      {trailingMessage && (
        <div className="task-checklist-note">{trailingMessage}</div>
      )}
    </div>
  );
}
