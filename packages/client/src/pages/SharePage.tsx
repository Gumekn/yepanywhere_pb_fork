import type { PublicSessionShareResponse } from "@yep-anywhere/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "../components/MessageList";
import { TranscriptRendererProvider } from "../components/TranscriptRendererProvider";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { SchemaValidationProvider } from "../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { StreamingMarkdownProvider } from "../contexts/StreamingMarkdownContext";
import { ToastProvider } from "../contexts/ToastContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import type { AgentContentMap } from "../hooks/useSession";
import { useI18n } from "../i18n";
import { API_BASE } from "../lib/apiPath";
import { buildShareMarkdownUrl } from "../lib/sessionShareLinks";
import { getProvider } from "../providers/registry";
import type { Message } from "../types";
import "../styles/session-share.css";

type ShareState =
  | { status: "loading" }
  | { status: "ready"; data: PublicSessionShareResponse }
  | { status: "not-found" }
  | { status: "failed"; message: string };

const EMPTY_AGENT_CONTENT: AgentContentMap = {};
const EMPTY_TOOL_MAP = new Map<string, string>();
const noop = () => undefined;

async function fetchShare(token: string): Promise<ShareState> {
  // Deliberately not the authenticated API client: a share viewer has no
  // session, and a 401 there would bounce them to the owner's login page.
  const response = await fetch(
    `${API_BASE}/public/session-shares/${encodeURIComponent(token)}`,
    { credentials: "omit" },
  );
  if (response.status === 404) return { status: "not-found" };
  if (!response.ok) {
    return { status: "failed", message: `${response.status}` };
  }
  return {
    status: "ready",
    data: (await response.json()) as PublicSessionShareResponse,
  };
}

/**
 * Public, read-only view of a frozen session snapshot.
 * Route: /share/:token — rendered outside the authenticated app shell.
 */
export function SharePage({ token }: { token: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<ShareState>({ status: "loading" });

  useHideSplashOnReady(state.status !== "loading");

  useEffect(() => {
    let cancelled = false;
    fetchShare(token)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const title =
    state.status === "ready"
      ? state.data.snapshot.session.title?.trim() || t("sessionUntitled")
      : null;

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (state.status === "loading") {
    return (
      <div className="share-page share-page--status">
        <p className="share-page__status">{t("sharePageLoading")}</p>
      </div>
    );
  }

  if (state.status === "not-found") {
    return (
      <div className="share-page share-page--status">
        <h1 className="share-page__status-title">
          {t("sharePageNotFoundTitle")}
        </h1>
        <p className="share-page__status">{t("sharePageNotFoundBody")}</p>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="share-page share-page--status">
        <p className="share-page__status">
          {t("sharePageLoadFailed", { message: state.message })}
        </p>
      </div>
    );
  }

  return (
    <ToastProvider>
      <SchemaValidationProvider>
        <StreamingMarkdownProvider>
          <TranscriptRendererProvider>
            <ShareTranscript token={token} data={state.data} title={title} />
          </TranscriptRendererProvider>
        </StreamingMarkdownProvider>
      </SchemaValidationProvider>
    </ToastProvider>
  );
}

function ShareTranscript({
  token,
  data,
  title,
}: {
  token: string;
  data: PublicSessionShareResponse;
  title: string | null;
}) {
  const { t } = useI18n();
  const { snapshot, share } = data;
  const messages = snapshot.messages as Message[];
  const scrollRef = useRef<HTMLElement>(null);
  const [agentContent, setAgentContent] =
    useState<AgentContentMap>(EMPTY_AGENT_CONTENT);

  // A share is read top-down like a document; the live transcript instead
  // pins to the newest turn. Two frames lets MessageList finish its own
  // initial bottom-anchoring before we override it.
  useLayoutEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: 0 });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  const meta = useMemo(
    () =>
      [
        snapshot.session.provider
          ? getProvider(snapshot.session.provider).displayName
          : null,
        snapshot.session.model,
        snapshot.session.projectName,
      ].filter((value): value is string => Boolean(value)),
    [snapshot.session],
  );

  return (
    <div className="session-page share-page">
      <header className="share-page__header">
        <div className="share-page__header-inner">
          <div className="share-page__heading">
            <h1 className="share-page__title">{title}</h1>
            <div className="share-page__meta">
              <span className="share-page__badge">
                {t("sharePageReadOnlyBadge")}
              </span>
              {meta.map((value) => (
                <span key={value}>{value}</span>
              ))}
              <span>
                {t("sharePageSnapshotTaken", {
                  time: new Date(snapshot.capturedAt).toLocaleString(),
                })}
              </span>
              {share.expiresAt && (
                <span>
                  {t("sharePageExpires", {
                    time: new Date(share.expiresAt).toLocaleString(),
                  })}
                </span>
              )}
            </div>
          </div>
          <a
            className="share-page__markdown-link"
            href={buildShareMarkdownUrl(token)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("sharePageViewMarkdown")}
          </a>
        </div>
        {(snapshot.truncated || snapshot.mediaOmitted) && (
          <div className="share-page__notices">
            {snapshot.truncated && <p>{t("sharePageTruncated")}</p>}
            {snapshot.mediaOmitted && <p>{t("sharePageMediaOmitted")}</p>}
          </div>
        )}
      </header>
      <main className="session-messages share-page__messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="share-page__status">{t("sharePageEmpty")}</p>
        ) : (
          <SessionMetadataProvider
            projectId=""
            projectPath={null}
            sessionId={token}
          >
            <AgentContentProvider
              agentContent={agentContent}
              setAgentContent={setAgentContent}
              toolUseToAgent={EMPTY_TOOL_MAP}
              projectId=""
              sessionId={token}
            >
              <MessageList
                messages={messages}
                provider={snapshot.session.provider}
                onCancelDeferred={noop}
                transcriptKey={`share:${token}`}
              />
            </AgentContentProvider>
          </SessionMetadataProvider>
        )}
      </main>
    </div>
  );
}
