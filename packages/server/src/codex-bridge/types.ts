import type {
  AgentActivity,
  InputRequest,
  PendingInputType,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface CodexBridgeStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  url: string;
  upstreamUrl: string | null;
  upstreamRunning: boolean;
  connectionCount: number;
  sessionCount: number;
  pendingInputCount: number;
  lastError: string | null;
}

export interface CodexBridgeSession {
  id: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: "codex";
  model?: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  connectionIds: number[];
}

export interface CodexBridgeSessionView {
  session: SessionSummary;
  projectName: string;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}

export interface CodexBridgePendingInput {
  request: InputRequest;
  method: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  createdAt: string;
}

export type CodexBridgeInputResponse =
  | "approve"
  | "approve_accept_edits"
  | "deny";

export type MaybePromise<T> = T | Promise<T>;

export interface CodexBridgeController {
  start?(): MaybePromise<void>;
  shutdown?(): MaybePromise<void>;
  getStatus(): MaybePromise<CodexBridgeStatus>;
  listSessions(): MaybePromise<CodexBridgeSession[]>;
  listSessionViews(): MaybePromise<CodexBridgeSessionView[]>;
  getSessionView(
    sessionId: string,
  ): MaybePromise<CodexBridgeSessionView | null>;
  isSessionActive(sessionId: string): MaybePromise<boolean>;
  getPendingInputRequest(
    sessionId: string,
  ): MaybePromise<CodexBridgePendingInput["request"] | null>;
  respondToInput(
    sessionId: string,
    requestId: string,
    response: CodexBridgeInputResponse,
    answers?: Record<string, string>,
  ): MaybePromise<boolean>;
}
