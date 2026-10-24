import { useI18n } from "../i18n";
import "../styles/side-conversation.css";

/** Opening a side draft does not depend on provider readiness or main-task state. */
export function SideConversationButton({
  onClick,
  expanded = false,
}: {
  onClick(): void;
  expanded?: boolean;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`slash-command-button side-conversation-launch${expanded ? " active" : ""}`}
      onClick={onClick}
      aria-label={t("sideChatTitle")}
      aria-expanded={expanded}
      aria-controls="side-conversation-panel"
      title={t("sideChatOpenHint")}
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
        <path d="M8 3h13v11h-4l-4 3v-3H8zM4 8H2v13l4-3h5" />
      </svg>
    </button>
  );
}
