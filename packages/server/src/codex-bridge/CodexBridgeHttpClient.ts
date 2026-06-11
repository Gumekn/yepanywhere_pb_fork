import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import type {
  CodexBridgeController,
  CodexBridgeInputResponse,
  CodexBridgePendingInput,
  CodexBridgeSession,
  CodexBridgeSessionView,
  CodexBridgeStatus,
} from "./types.js";

interface CodexBridgeHttpClientOptions {
  baseUrl: string;
  eventBus?: EventBus;
  pollIntervalMs?: number;
}

interface SessionPollState {
  projectId: CodexBridgeSession["projectId"];
  updatedAt: string;
  title: string | null;
  messageCount: number;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  active: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class CodexBridgeHttpClient implements CodexBridgeController {
  private readonly baseUrl: string;
  private readonly eventBus?: EventBus;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private knownSessions = new Map<string, SessionPollState>();

  constructor(options: CodexBridgeHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.eventBus = options.eventBus;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (!this.eventBus || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollSessions();
    }, this.pollIntervalMs);
    void this.pollSessions();
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async getStatus(): Promise<CodexBridgeStatus> {
    return (
      (await this.fetchJson<CodexBridgeStatus>("/status")) ?? {
        enabled: true,
        listening: false,
        host: "127.0.0.1",
        port: 0,
        url: this.baseUrl.replace(/^http:/, "ws:"),
        upstreamUrl: null,
        upstreamRunning: false,
        connectionCount: 0,
        sessionCount: 0,
        pendingInputCount: 0,
        lastError: "Codex bridge sidecar is unavailable",
      }
    );
  }

  async listSessions(): Promise<CodexBridgeSession[]> {
    const data = await this.fetchJson<{ sessions?: CodexBridgeSession[] }>(
      "/sessions",
    );
    return data?.sessions ?? [];
  }

  async listSessionViews(): Promise<CodexBridgeSessionView[]> {
    const data = await this.fetchJson<{ sessions?: CodexBridgeSessionView[] }>(
      "/session-views",
    );
    return (data?.sessions ?? []).filter((view) =>
      this.isDisplayableBridgeSession(view.session, {
        activity: view.activity,
        pendingInputType: view.pendingInputType,
      }),
    );
  }

  async getSessionView(
    sessionId: string,
  ): Promise<CodexBridgeSessionView | null> {
    const data = await this.fetchJson<{
      sessionView?: CodexBridgeSessionView | null;
    }>(`/sessions/${encodeURIComponent(sessionId)}/view`);
    const view = data?.sessionView ?? null;
    if (
      view &&
      !this.isDisplayableBridgeSession(view.session, {
        activity: view.activity,
        pendingInputType: view.pendingInputType,
      })
    ) {
      return null;
    }
    return view;
  }

  async isSessionActive(sessionId: string): Promise<boolean> {
    const data = await this.fetchJson<{ active?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/active`,
    );
    return data?.active ?? false;
  }

  async getPendingInputRequest(
    sessionId: string,
  ): Promise<CodexBridgePendingInput["request"] | null> {
    const data = await this.fetchJson<{
      request?: CodexBridgePendingInput["request"] | null;
    }>(`/sessions/${encodeURIComponent(sessionId)}/pending-input`);
    return data?.request ?? null;
  }

  async respondToInput(
    sessionId: string,
    requestId: string,
    response: CodexBridgeInputResponse,
    answers?: Record<string, string>,
  ): Promise<boolean> {
    const data = await this.fetchJson<{ accepted?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/input`,
      {
        method: "POST",
        body: JSON.stringify({ requestId, response, answers }),
      },
    );
    return data?.accepted ?? false;
  }

  private async fetchJson<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...init?.headers,
        },
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  private async pollSessions(): Promise<void> {
    if (!this.eventBus || this.polling) return;
    this.polling = true;
    try {
      const [sessions, views] = await Promise.all([
        this.listSessions(),
        this.listSessionViews(),
      ]);
      const viewsById = new Map(views.map((view) => [view.session.id, view]));
      const nextIds = new Set<string>();

      for (const session of sessions) {
        const view = viewsById.get(session.id);
        if (!view) continue;
        nextIds.add(session.id);
        this.emitChanges(session, view);
      }

      for (const [sessionId, previous] of this.knownSessions) {
        if (!nextIds.has(sessionId) && previous.active) {
          this.eventBus.emit({
            type: "session-status-changed",
            sessionId,
            projectId: previous.projectId,
            ownership: { owner: "none" },
            timestamp: new Date().toISOString(),
          });
          this.knownSessions.delete(sessionId);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private emitChanges(
    session: CodexBridgeSession,
    view: CodexBridgeSessionView,
  ): void {
    if (!this.eventBus) return;

    const active = session.connectionIds.length > 0;
    const previous = this.knownSessions.get(session.id);
    const next: SessionPollState = {
      projectId: session.projectId,
      updatedAt: session.updatedAt,
      title: session.title,
      messageCount: session.messageCount,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      serviceTier: session.serviceTier,
      activity: session.activity,
      pendingInputType: session.pendingInputType,
      active,
    };
    this.knownSessions.set(session.id, next);

    const timestamp = new Date().toISOString();
    if (!previous) {
      this.eventBus.emit({
        type: "session-created",
        session: view.session,
        timestamp,
      });
    }

    if (!previous || previous.active !== active) {
      this.eventBus.emit({
        type: "session-status-changed",
        sessionId: session.id,
        projectId: session.projectId,
        ownership: active
          ? ({ owner: "external" } as SessionSummary["ownership"])
          : ({ owner: "none" } as SessionSummary["ownership"]),
        timestamp,
      });
    }

    if (
      !previous ||
      previous.activity !== session.activity ||
      previous.pendingInputType !== session.pendingInputType
    ) {
      this.eventBus.emit({
        type: "process-state-changed",
        sessionId: session.id,
        projectId: session.projectId,
        activity: session.activity ?? "idle",
        pendingInputType: session.pendingInputType,
        timestamp,
      });
    }

    if (
      !previous ||
      previous.updatedAt !== session.updatedAt ||
      previous.title !== session.title ||
      previous.messageCount !== session.messageCount ||
      previous.model !== session.model ||
      previous.reasoningEffort !== session.reasoningEffort ||
      previous.serviceTier !== session.serviceTier
    ) {
      this.eventBus.emit({
        type: "session-updated",
        sessionId: session.id,
        projectId: session.projectId,
        title: session.title,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        serviceTier: session.serviceTier,
        timestamp,
      });
    }
  }

  private isDisplayableBridgeSession(
    session: SessionSummary,
    state?: { activity?: AgentActivity; pendingInputType?: PendingInputType },
  ): boolean {
    return (
      session.messageCount > 0 ||
      state?.activity === "in-turn" ||
      state?.activity === "waiting-input" ||
      !!state?.pendingInputType ||
      !!session.pendingInputType
    );
  }
}
