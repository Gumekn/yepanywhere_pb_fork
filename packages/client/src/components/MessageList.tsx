import type { MarkdownAugment } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ActiveToolApproval,
  isPlanProgressItem,
  preprocessMessages,
} from "../lib/preprocessMessages";
import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { getMessageId } from "../utils";
import { MessageActions } from "./MessageActions";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { RenderItemComponent } from "./RenderItemComponent";

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
function groupItemsIntoTurns(
  items: RenderItem[],
): Array<{ isUserPrompt: boolean; items: RenderItem[] }> {
  const groups: Array<{ isUserPrompt: boolean; items: RenderItem[] }> = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "user_prompt" || item.type === "session_setup") {
      // Flush any pending assistant items
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      // User prompt is its own group
      groups.push({ isUserPrompt: true, items: [item] });
    } else {
      // Accumulate assistant items
      currentAssistantGroup.push(item);
    }
  }

  // Flush remaining assistant items
  if (currentAssistantGroup.length > 0) {
    groups.push({ isUserPrompt: false, items: currentAssistantGroup });
  }

  return groups;
}

function getBranchId(item: RenderItem): string | undefined {
  if (item.type !== "user_prompt") return undefined;
  const source = item.sourceMessages[0];
  return source?.branch?.branchId ?? source?.codexBranch?.branchId;
}

/** Pending message waiting for server confirmation */
interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  status?: string;
}

/** Deferred message queued server-side */
interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
}

interface Props {
  messages: Message[];
  /** Preprocessed items shared with parent computations. Falls back to messages. */
  preprocessedItems?: RenderItem[];
  provider?: string;
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** True when context is being compressed */
  isCompacting?: boolean;
  /** Increment this to force scroll to bottom (e.g., when user sends a message) */
  scrollTrigger?: number;
  /** Messages waiting for server confirmation (shown as "Sending...") */
  pendingMessages?: PendingMessage[];
  /** Deferred messages queued server-side (shown as "Queued") */
  deferredMessages?: DeferredMessage[];
  /** Callback to cancel a deferred message */
  onCancelDeferred?: (tempId: string) => void;
  /** Pre-rendered markdown HTML from server (keyed by message ID) */
  markdownAugments?: Record<string, MarkdownAugment>;
  /** Active tool approval - prevents matching orphaned tool from showing as interrupted */
  activeToolApproval?: ActiveToolApproval;
  /** Whether there are older messages not yet loaded */
  hasOlderMessages?: boolean;
  /** Whether there are newer messages not yet loaded */
  hasNewerMessages?: boolean;
  /** Whether older messages are currently being loaded */
  loadingOlder?: boolean;
  /** Whether newer messages are currently being loaded */
  loadingNewer?: boolean;
  /** Whether a target-message window is currently being loaded */
  loadingTargetMessage?: boolean;
  /** Callback to load the next chunk of older messages */
  onLoadOlderMessages?: () => void;
  /** Callback to load the next chunk of newer messages */
  onLoadNewerMessages?: () => void;
  /** Callback to load a bounded window around a target message */
  onLoadTargetMessage?: (messageId: string) => Promise<boolean> | boolean;
  /** Edit/rewind a past user prompt (forks the session from that point) */
  onEditUserPrompt?: (args: {
    text: string;
    uuid: string;
    parentUuid: string | null;
  }) => void;
  /** Switch the rendered derived branch. */
  onSelectBranch?: (branchId: string) => void;
  /** Branch prompt to bring back into view after switching. */
  focusBranchId?: string | null;
  /** Called after the selected branch prompt has been focused. */
  onBranchFocused?: () => void;
  /** Message id to scroll to and highlight (e.g. from a search deep-link). */
  targetMessageId?: string | null;
  /** Called after the target message has been focused. */
  onTargetFocused?: () => void;
}

export const MessageList = memo(function MessageList({
  messages,
  preprocessedItems,
  provider,
  isStreaming = false,
  isProcessing = false,
  isCompacting = false,
  scrollTrigger = 0,
  pendingMessages = [],
  deferredMessages = [],
  onCancelDeferred,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages = false,
  hasNewerMessages = false,
  loadingOlder = false,
  loadingNewer = false,
  loadingTargetMessage = false,
  onLoadOlderMessages,
  onLoadNewerMessages,
  onLoadTargetMessage,
  onEditUserPrompt,
  onSelectBranch,
  focusBranchId,
  onBranchFocused,
  targetMessageId,
  onTargetFocused,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedBranchRef = useRef<HTMLDivElement | null>(null);
  const targetMessageRef = useRef<HTMLDivElement | null>(null);
  const requestedTargetMessageRef = useRef<string | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);
  const followUpScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // Scroll to bottom, marking it as programmatic so scroll handler ignores it
  const scrollToBottom = useCallback((container: HTMLElement) => {
    isProgrammaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight - container.clientHeight;
    lastHeightRef.current = container.scrollHeight;

    // Clear programmatic flag after scroll events have fired
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });

    // Schedule a follow-up scroll to catch any async rendering (markdown, syntax highlighting)
    if (followUpScrollRef.current !== null) {
      clearTimeout(followUpScrollRef.current);
    }
    followUpScrollRef.current = setTimeout(() => {
      followUpScrollRef.current = null;
      if (shouldAutoScrollRef.current) {
        isProgrammaticScrollRef.current = true;
        container.scrollTop = container.scrollHeight - container.clientHeight;
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      }
    }, 50);
  }, []);

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(
    () =>
      preprocessedItems ??
      preprocessMessages(messages, {
        markdown: markdownAugments,
        activeToolApproval,
      }),
    [preprocessedItems, messages, markdownAugments, activeToolApproval],
  );
  const visibleRenderItems = useMemo(
    () => renderItems.filter((item) => !isPlanProgressItem(item)),
    [renderItems],
  );
  const turnGroups = useMemo(
    () => groupItemsIntoTurns(visibleRenderItems),
    [visibleRenderItems],
  );
  const focusedBranchItemId = useMemo(() => {
    if (!focusBranchId) return null;
    return (
      visibleRenderItems.find((item) => getBranchId(item) === focusBranchId)
        ?.id ?? null
    );
  }, [focusBranchId, visibleRenderItems]);

  // Render item that contains the deep-link target message (search results).
  const targetItemId = useMemo(() => {
    if (!targetMessageId) return null;
    return (
      visibleRenderItems.find((item) =>
        item.sourceMessages.some((m) => getMessageId(m) === targetMessageId),
      )?.id ?? null
    );
  }, [targetMessageId, visibleRenderItems]);

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  // Load older messages with scroll position preservation
  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlderMessages) return;
    const container = containerRef.current?.parentElement;
    if (!container) {
      onLoadOlderMessages();
      return;
    }
    // Capture scroll state before prepending older messages
    const scrollHeightBefore = container.scrollHeight;
    const scrollTopBefore = container.scrollTop;
    onLoadOlderMessages();
    // Restore scroll position after React re-renders with prepended messages
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollHeightAfter = container.scrollHeight;
        const heightDelta = scrollHeightAfter - scrollHeightBefore;
        isProgrammaticScrollRef.current = true;
        container.scrollTop = scrollTopBefore + heightDelta;
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    });
  }, [onLoadOlderMessages]);

  const handleLoadNewer = useCallback(() => {
    onLoadNewerMessages?.();
  }, [onLoadNewerMessages]);

  // Mirror the auto-load state into a ref so handleScroll (which only binds
  // once for the lifetime of the listener) can read the latest values without
  // re-attaching the listener on every prop change.
  const loadOlderStateRef = useRef({
    hasOlderMessages,
    loadingOlder,
    loadOlder: handleLoadOlder,
  });
  loadOlderStateRef.current = {
    hasOlderMessages,
    loadingOlder,
    loadOlder: handleLoadOlder,
  };

  // Track scroll position to determine if user is near bottom.
  // Ignore programmatic scrolls - only user-initiated scrolls should affect auto-scroll state.
  // Also auto-trigger "load older" when the user nears the top of the
  // scrollable area — gives WhatsApp/Telegram-style infinite scroll instead
  // of forcing them to hunt for a button on a long, slow-loading session.
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const container = containerRef.current?.parentElement;
    if (!container) return;

    const threshold = 100; // pixels from bottom
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;

    // Top-of-list auto-load. handleLoadOlder anchors scroll position via the
    // pre-/post-render scrollHeight delta, so the user's view stays put — no
    // visible "jump" when the prepended chunk lands.
    const TOP_LOAD_THRESHOLD = 200;
    const {
      hasOlderMessages: hasOlder,
      loadingOlder: loading,
      loadOlder,
    } = loadOlderStateRef.current;
    if (
      hasOlder &&
      !loading &&
      loadOlder &&
      container.scrollTop < TOP_LOAD_THRESHOLD
    ) {
      loadOlder();
    }
  }, []);

  // Attach scroll listener to parent container
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll]);

  // Use ResizeObserver to detect content height changes (handles async markdown rendering)
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const scrollContainer = container;
    lastHeightRef.current = scrollContainer.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = scrollContainer.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;

      // Auto-scroll when content height increases and auto-scroll is enabled
      if (heightIncreased && shouldAutoScrollRef.current) {
        scrollToBottom(scrollContainer);
      } else {
        // Update height tracking even when not scrolling
        lastHeightRef.current = newHeight;
      }
    });

    // Observe the inner container (message-list) since that's what changes size
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      // Clean up any pending scroll on unmount
      if (followUpScrollRef.current !== null) {
        clearTimeout(followUpScrollRef.current);
      }
    };
  }, [scrollToBottom]);

  // Force scroll to bottom when scrollTrigger changes (user sent a message)
  useEffect(() => {
    if (scrollTrigger > 0) {
      shouldAutoScrollRef.current = true;
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
    }
  }, [scrollTrigger, scrollToBottom]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && renderItems.length > 0) {
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
      isInitialLoadRef.current = false;
    }
  }, [renderItems.length, scrollToBottom]);

  useEffect(() => {
    if (!focusBranchId || !focusedBranchItemId) return;
    const target = focusedBranchRef.current;
    const container = containerRef.current?.parentElement;
    if (!target || !container) return;

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      isProgrammaticScrollRef.current = true;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus({ preventScroll: true });
      lastHeightRef.current = container.scrollHeight;
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
      onBranchFocused?.();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [focusBranchId, focusedBranchItemId, onBranchFocused]);

  // Scroll to + highlight a deep-linked target message (e.g. search result).
  // If it is not in the current window, ask the server for a bounded window
  // centered on that exact message. This avoids blind repeated pagination.
  useEffect(() => {
    if (!targetMessageId) {
      requestedTargetMessageRef.current = null;
      return;
    }

    // Found in the current window — scroll and highlight it.
    if (targetItemId) {
      requestedTargetMessageRef.current = null;
      const target = targetMessageRef.current;
      const container = containerRef.current?.parentElement;
      if (!target || !container) return;

      let cancelled = false;
      const raf = requestAnimationFrame(() => {
        if (cancelled) return;
        isProgrammaticScrollRef.current = true;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
        // Self-clearing highlight: the CSS animation removes itself on end, so
        // it survives the re-render triggered by onTargetFocused() below.
        target.classList.remove("message-target-highlight");
        target.addEventListener(
          "animationend",
          () => target.classList.remove("message-target-highlight"),
          { once: true },
        );
        // Force reflow so re-adding the class restarts the animation.
        void target.offsetWidth;
        target.classList.add("message-target-highlight");
        onTargetFocused?.();
      });

      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }

    if (
      onLoadTargetMessage &&
      !loadingTargetMessage &&
      requestedTargetMessageRef.current !== targetMessageId
    ) {
      requestedTargetMessageRef.current = targetMessageId;
      let cancelled = false;

      void Promise.resolve(onLoadTargetMessage(targetMessageId)).then(
        (found) => {
          if (cancelled) return;
          if (!found && requestedTargetMessageRef.current === targetMessageId) {
            requestedTargetMessageRef.current = null;
            onTargetFocused?.();
          }
        },
      );

      return () => {
        cancelled = true;
      };
    }
  }, [
    targetMessageId,
    targetItemId,
    loadingTargetMessage,
    onLoadTargetMessage,
    onTargetFocused,
  ]);

  return (
    <div className="message-list" ref={containerRef}>
      {hasOlderMessages && (
        <div className="load-older-messages">
          <button
            type="button"
            className="load-older-button"
            onClick={handleLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? (
              <>
                <span className="spinning">&#x21BB;</span> Loading...
              </>
            ) : (
              "Load older messages"
            )}
          </button>
        </div>
      )}
      {turnGroups.map((group) => {
        if (group.isUserPrompt) {
          // User prompts render directly without timeline wrapper
          const item = group.items[0];
          if (!item) return null;
          const shouldFocusBranch = item.id === focusedBranchItemId;
          const isTarget = item.id === targetItemId;
          const renderedItem = (
            <RenderItemComponent
              key={item.id}
              item={item}
              isStreaming={isStreaming}
              thinkingExpanded={thinkingExpanded}
              toggleThinkingExpanded={toggleThinkingExpanded}
              sessionProvider={provider}
              onEditUserPrompt={onEditUserPrompt}
              onSelectBranch={onSelectBranch}
            />
          );
          if (!shouldFocusBranch && !isTarget) return renderedItem;
          return (
            <div
              key={item.id}
              ref={(node) => {
                if (shouldFocusBranch) focusedBranchRef.current = node;
                if (isTarget) targetMessageRef.current = node;
              }}
              className={
                shouldFocusBranch ? "codex-branch-focus-target" : undefined
              }
              tabIndex={shouldFocusBranch ? -1 : undefined}
            >
              {renderedItem}
            </div>
          );
        }
        // Assistant items wrapped in timeline container - key based on first item
        const firstItem = group.items[0];
        if (!firstItem) return null;
        const turnTimestamp = firstItem.sourceMessages[0]?.timestamp;
        // Concatenate text-block content for the copy button; tool calls and
        // thinking blocks are skipped because copying their structured form
        // as plain text isn't useful.
        const turnCopyText = group.items
          .filter(
            (item): item is RenderItem & { type: "text"; text: string } =>
              item.type === "text" &&
              typeof (item as { text?: unknown }).text === "string",
          )
          .map((item) => item.text)
          .join("\n\n")
          .trim();
        const turnHasTarget = group.items.some(
          (item) => item.id === targetItemId,
        );
        return (
          <div
            key={`turn-${firstItem.id}`}
            className="assistant-turn"
            ref={turnHasTarget ? targetMessageRef : undefined}
          >
            {group.items.map((item) => (
              <RenderItemComponent
                key={item.id}
                item={item}
                isStreaming={isStreaming}
                thinkingExpanded={thinkingExpanded}
                toggleThinkingExpanded={toggleThinkingExpanded}
                sessionProvider={provider}
                onSelectBranch={onSelectBranch}
              />
            ))}
            <MessageActions
              timestamp={turnTimestamp}
              copyText={turnCopyText || undefined}
            />
          </div>
        );
      })}
      {hasNewerMessages && (
        <div className="load-older-messages">
          <button
            type="button"
            className="load-older-button"
            onClick={handleLoadNewer}
            disabled={loadingNewer}
          >
            {loadingNewer ? (
              <>
                <span className="spinning">&#x21BB;</span> Loading...
              </>
            ) : (
              "Load newer messages"
            )}
          </button>
        </div>
      )}
      {/* Pending messages - shown as "Uploading..." or "Sending..." until server confirms */}
      {pendingMessages.map((pending) => (
        <div key={pending.tempId} className="pending-message">
          <div className="message-user-prompt pending-message-bubble">
            {pending.content}
          </div>
          <div className="pending-message-status">
            {pending.status || "Sending..."}
          </div>
        </div>
      ))}
      {/* Deferred messages - queued server-side, waiting for agent turn to end */}
      {deferredMessages.map((deferred, index) => (
        <div
          key={deferred.tempId ?? `deferred-${index}`}
          className="deferred-message"
        >
          <div className="message-user-prompt deferred-message-bubble">
            {deferred.content}
          </div>
          <div className="deferred-message-footer">
            <span className="deferred-message-status">
              {index === 0 ? "Queued (next)" : `Queued (#${index + 1})`}
            </span>
            {deferred.tempId && onCancelDeferred && (
              <button
                type="button"
                className="deferred-message-cancel"
                onClick={() => onCancelDeferred(deferred.tempId as string)}
                aria-label="Cancel queued message"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
      {/* Compacting indicator - shown when context is being compressed */}
      {isCompacting && (
        <div className="system-message system-message-compacting">
          <span className="system-message-icon spinning">⟳</span>
          <span className="system-message-text">Compacting context...</span>
        </div>
      )}
      <ProcessingIndicator isProcessing={isProcessing} />
    </div>
  );
});
