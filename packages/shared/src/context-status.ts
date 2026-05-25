/**
 * Context usage breakdown shape returned by `GET /api/projects/:projectId/sessions/:sessionId/context-status`.
 *
 * Fields mirror SDKControlGetContextUsageResponse from @anthropic-ai/claude-agent-sdk.
 * When the live SDK Process is available we return `source: "sdk"` with full breakdown;
 * otherwise we fall back to a coarse estimate derived from the persisted JSONL.
 */

import type { ContextUsage } from "./app-types.js";

export interface ContextCategoryEntry {
  name: string;
  tokens: number;
  color?: string;
}

export interface ContextMcpToolEntry {
  name: string;
  serverName: string;
  tokens: number;
  isLoaded?: boolean;
}

export interface ContextMemoryFileEntry {
  path: string;
  type: string;
  tokens: number;
}

export interface ContextSkillFrontmatterEntry {
  name: string;
  source: string;
  tokens: number;
}

export interface ContextSkillsSummary {
  totalSkills: number;
  includedSkills: number;
  tokens: number;
  skillFrontmatter: ContextSkillFrontmatterEntry[];
}

export interface ContextSlashCommandsSummary {
  totalCommands: number;
  includedCommands: number;
  tokens: number;
}

export interface ContextAgentEntry {
  agentType: string;
  source: string;
  tokens: number;
}

export interface ContextSystemPromptSection {
  name: string;
  tokens: number;
}

export interface ContextSystemTool {
  name: string;
  tokens: number;
}

export interface ContextDeferredBuiltinTool {
  name: string;
  tokens: number;
  isLoaded: boolean;
}

/**
 * Live, structured breakdown coming straight from the SDK
 * (Query.getContextUsage()).
 */
export interface ContextStatusSdkPayload {
  source: "sdk";
  /** Model id reported by the SDK at query time (may differ from session.model). */
  model: string;
  totalTokens: number;
  /** Effective max tokens (may be reduced by auto-compact threshold). */
  maxTokens: number;
  /** Raw model max tokens (the model's actual context window). */
  rawMaxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  categories: ContextCategoryEntry[];
  mcpTools: ContextMcpToolEntry[];
  memoryFiles: ContextMemoryFileEntry[];
  agents: ContextAgentEntry[];
  slashCommands?: ContextSlashCommandsSummary;
  skills?: ContextSkillsSummary;
  systemPromptSections?: ContextSystemPromptSection[];
  systemTools?: ContextSystemTool[];
  deferredBuiltinTools?: ContextDeferredBuiltinTool[];
}

/**
 * Fallback estimate when no live Process exists (e.g. CLI-started session
 * opened in yepanywhere, or after server restart before the process is revived).
 */
export interface ContextStatusEstimatePayload {
  source: "jsonl";
  /** Model id read from the last assistant message in the JSONL. */
  model?: string;
  /**
   * Best-effort context window: from persisted ModelInfoService cache if known,
   * otherwise the heuristic from getModelContextWindow().
   */
  contextWindow: number;
  /** Whether the contextWindow came from a previously observed SDK value. */
  contextWindowFromCache: boolean;
  /** Same shape as the meter at the bottom of the input toolbar. */
  contextUsage?: ContextUsage;
}

export type ContextStatusResponse =
  | ContextStatusSdkPayload
  | ContextStatusEstimatePayload;
