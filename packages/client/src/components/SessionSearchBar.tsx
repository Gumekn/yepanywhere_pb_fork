import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type SearchMatch, api } from "../api/client";
import { useI18n } from "../i18n";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

/** One hit: the Nth occurrence of the query inside one message. */
export interface SessionSearchOccurrence {
  messageId: string;
  occurrence: number;
}

/** Flatten per-message matches (in transcript order) into single hits. */
export function flattenSearchOccurrences(
  matches: readonly SearchMatch[],
): SessionSearchOccurrence[] {
  return matches.flatMap((match) =>
    Array.from(
      { length: Math.max(1, match.occurrenceCount ?? 1) },
      (_, occurrence) => ({ messageId: match.messageId, occurrence }),
    ),
  );
}

interface SessionSearchBarProps {
  isOpen: boolean;
  projectId: string;
  sessionId: string;
  onOpen: () => void;
  onClose: () => void;
  onSelectMatch: (match: SessionSearchOccurrence) => void;
  /** The query whose hits are listed, or null when nothing is searched. */
  onQueryChange?: (query: string | null) => void;
}

export function SessionSearchBar({
  isOpen,
  projectId,
  sessionId,
  onOpen,
  onClose,
  onSelectMatch,
  onQueryChange,
}: SessionSearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [inputValue, setInputValue] = useState("");
  const [matches, setMatches] = useState<SessionSearchOccurrence[]>([]);
  const [limited, setLimited] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Off by default and reset on close: only the final answers are searched
  // unless the user opts into the progress text folded behind "process" rows.
  const [includeFolded, setIncludeFolded] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }

      const isFindShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f";
      if (isFindShortcut) {
        event.preventDefault();
        if (isOpen) inputRef.current?.focus();
        else onOpen();
        return;
      }

      if (isOpen && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, onOpen]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setLoading(false);
      setIncludeFolded(false);
      return;
    }

    const query = inputValue.trim();
    setMatches([]);
    setLimited(false);
    setCurrentIndex(-1);
    setFailed(false);

    if (query.length < MIN_QUERY_LENGTH) {
      setLoading(false);
      onQueryChange?.(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .search({
          q: query,
          project: projectId,
          session: sessionId,
          limit: 1,
          ...(includeFolded ? { includeFolded: true } : {}),
        })
        .then((response) => {
          if (cancelled) return;
          const result = response.results.find(
            (candidate) => candidate.sessionId === sessionId,
          );
          const nextMatches = flattenSearchOccurrences(result?.matches ?? []);
          setMatches(nextMatches);
          setLimited((result?.matchCount ?? 0) > (result?.matches.length ?? 0));
          onQueryChange?.(query);
          // Start at the latest hit: the transcript opens at its newest turn,
          // so this is the nearest one and needs no history paging.
          const lastIndex = nextMatches.length - 1;
          const latest = nextMatches[lastIndex];
          if (latest) {
            setCurrentIndex(lastIndex);
            onSelectMatch(latest);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    includeFolded,
    inputValue,
    isOpen,
    onQueryChange,
    onSelectMatch,
    projectId,
    sessionId,
  ]);

  const selectMatch = useCallback(
    (index: number) => {
      const match = matches[index];
      if (!match) return;
      setCurrentIndex(index);
      onSelectMatch(match);
    },
    [matches, onSelectMatch],
  );

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      if (matches.length === 0) return;
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        (baseIndex + direction + matches.length) % matches.length;
      selectMatch(nextIndex);
    },
    [currentIndex, matches.length, selectMatch],
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      moveSelection(event.shiftKey ? -1 : 1);
    },
    [moveSelection],
  );

  const statusText = useMemo(() => {
    const query = inputValue.trim();
    if (loading) return t("sessionSearchLoading");
    if (failed) return t("sessionSearchFailed");
    if (query.length < MIN_QUERY_LENGTH) return t("sessionSearchHint");
    if (matches.length === 0) return t("sessionSearchNoResults");

    const current = Math.max(1, currentIndex + 1);
    if (limited) {
      return t("sessionSearchPositionLimited", {
        current,
        shown: matches.length,
      });
    }
    return t("sessionSearchPosition", {
      current,
      total: matches.length,
    });
  }, [currentIndex, failed, inputValue, limited, loading, matches.length, t]);

  if (!isOpen) return null;

  return (
    <div
      id="session-search-panel"
      className="session-search-bar"
      role="search"
      aria-label={t("sessionSearchTitle")}
    >
      <div className="session-search-bar-inner">
        <svg
          className="session-search-leading-icon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          className="session-search-input"
          value={inputValue}
          placeholder={t("sessionSearchPlaceholder")}
          aria-label={t("sessionSearchTitle")}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <span
          id={statusId}
          className={`session-search-status${failed ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </span>
        <div className="session-search-controls">
          <button
            type="button"
            className={`session-search-control session-search-folded-toggle${
              includeFolded ? " is-active" : ""
            }`}
            onClick={() => setIncludeFolded((value) => !value)}
            aria-pressed={includeFolded}
            title={t("sessionSearchIncludeFolded")}
            aria-label={t("sessionSearchIncludeFolded")}
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
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </button>
          <button
            type="button"
            className="session-search-control"
            onClick={() => moveSelection(-1)}
            disabled={matches.length === 0}
            title={t("sessionSearchPrevious")}
            aria-label={t("sessionSearchPrevious")}
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
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            type="button"
            className="session-search-control"
            onClick={() => moveSelection(1)}
            disabled={matches.length === 0}
            title={t("sessionSearchNext")}
            aria-label={t("sessionSearchNext")}
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
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button
            type="button"
            className="session-search-control session-search-close"
            onClick={onClose}
            title={t("sessionSearchClose")}
            aria-label={t("sessionSearchClose")}
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
