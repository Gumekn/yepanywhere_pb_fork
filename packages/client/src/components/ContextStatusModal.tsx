import type { ContextStatusResponse } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface ContextStatusModalProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

export function ContextStatusModal({
  projectId,
  sessionId,
  onClose,
}: ContextStatusModalProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ContextStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getContextStatus(projectId, sessionId);
      setData(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal
      title={
        <span className="context-status-title">
          {t("contextBreakdownTitle")}
          <button
            type="button"
            className="context-status-refresh"
            onClick={load}
            disabled={loading}
            title={t("contextRefreshTooltip")}
            aria-label={t("contextRefreshTooltip")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
        </span>
      }
      onClose={onClose}
    >
      {loading && !data && (
        <p className="context-status-loading">{t("sidebarLoadingSessions")}</p>
      )}
      {error && <p className="context-status-error">{error}</p>}
      {data && <ContextStatusContent data={data} />}
    </Modal>
  );
}

function ContextStatusContent({ data }: { data: ContextStatusResponse }) {
  const { t } = useI18n();

  if (data.source === "jsonl") {
    const used = data.contextUsage?.inputTokens ?? 0;
    const cw = data.contextWindow;
    const pct = cw > 0 ? Math.round((used / cw) * 100) : 0;
    return (
      <div className="context-status-body">
        <SourceBadge source="jsonl" />
        <div className="context-status-summary">
          <div className="context-status-meter">
            <span className="context-status-percent">{pct}%</span>
            <span className="context-status-meter-detail">
              {formatTokens(used)} / {formatTokens(cw)}
            </span>
          </div>
          {data.model && (
            <div className="context-status-meta">
              <span className="context-status-meta-label">
                {t("processInfoLabelModel")}
              </span>
              <span className="context-status-meta-value">{data.model}</span>
            </div>
          )}
          {!data.contextWindowFromCache && (
            <p className="context-status-hint">
              {t("contextBreakdownEstimateHint")}
            </p>
          )}
        </div>
      </div>
    );
  }

  // SDK breakdown
  const sortedCategories = [...data.categories].sort(
    (a, b) => b.tokens - a.tokens,
  );

  return (
    <div className="context-status-body">
      <SourceBadge source="sdk" />
      <div className="context-status-summary">
        <div className="context-status-meter">
          <span className="context-status-percent">{data.percentage}%</span>
          <span className="context-status-meter-detail">
            {formatTokens(data.totalTokens)} / {formatTokens(data.maxTokens)}
          </span>
        </div>
        <div className="context-status-meta">
          <span className="context-status-meta-label">
            {t("processInfoLabelModel")}
          </span>
          <span className="context-status-meta-value">{data.model}</span>
        </div>
        {data.rawMaxTokens !== data.maxTokens && (
          <div className="context-status-meta">
            <span className="context-status-meta-label">
              {t("contextBreakdownRawMaxLabel")}
            </span>
            <span className="context-status-meta-value">
              {formatTokens(data.rawMaxTokens)}
            </span>
          </div>
        )}
      </div>

      <Section heading={t("contextCategoryHeading")}>
        <ul className="context-status-list">
          {sortedCategories.map((c) => {
            const pct =
              data.maxTokens > 0
                ? Math.round((c.tokens / data.maxTokens) * 100)
                : 0;
            return (
              <li key={c.name} className="context-status-row">
                <span className="context-status-row-label">{c.name}</span>
                <span className="context-status-row-bar">
                  <span
                    className="context-status-row-bar-fill"
                    style={{
                      width: `${Math.min(100, pct)}%`,
                      backgroundColor: c.color || undefined,
                    }}
                  />
                </span>
                <span className="context-status-row-tokens">
                  {formatTokens(c.tokens)}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      {data.mcpTools.length > 0 && (
        <Section heading={t("contextMcpHeading")}>
          <ul className="context-status-list">
            {[...data.mcpTools]
              .sort((a, b) => b.tokens - a.tokens)
              .map((tool) => (
                <li
                  key={`${tool.serverName}:${tool.name}`}
                  className="context-status-row"
                >
                  <span className="context-status-row-label">
                    {tool.serverName} / {tool.name}
                  </span>
                  <span className="context-status-row-tokens">
                    {formatTokens(tool.tokens)}
                  </span>
                </li>
              ))}
          </ul>
        </Section>
      )}

      {data.skills && data.skills.includedSkills > 0 && (
        <Section
          heading={`${t("contextSkillsHeading")} (${data.skills.includedSkills}/${data.skills.totalSkills})`}
        >
          <ul className="context-status-list">
            {[...data.skills.skillFrontmatter]
              .sort((a, b) => b.tokens - a.tokens)
              .map((s) => (
                <li key={s.name} className="context-status-row">
                  <span className="context-status-row-label">{s.name}</span>
                  <span className="context-status-row-tokens">
                    {formatTokens(s.tokens)}
                  </span>
                </li>
              ))}
          </ul>
        </Section>
      )}

      {data.memoryFiles.length > 0 && (
        <Section heading={t("contextMemoryHeading")}>
          <ul className="context-status-list">
            {[...data.memoryFiles]
              .sort((a, b) => b.tokens - a.tokens)
              .map((f) => (
                <li key={f.path} className="context-status-row">
                  <span className="context-status-row-label">{f.path}</span>
                  <span className="context-status-row-tokens">
                    {formatTokens(f.tokens)}
                  </span>
                </li>
              ))}
          </ul>
        </Section>
      )}

      {data.slashCommands && data.slashCommands.includedCommands > 0 && (
        <Section heading={t("contextSlashCommandsHeading")}>
          <p className="context-status-row">
            <span className="context-status-row-label">
              {data.slashCommands.includedCommands} /{" "}
              {data.slashCommands.totalCommands}
            </span>
            <span className="context-status-row-tokens">
              {formatTokens(data.slashCommands.tokens)}
            </span>
          </p>
        </Section>
      )}
    </div>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="context-status-section">
      <h4 className="context-status-section-heading">{heading}</h4>
      {children}
    </section>
  );
}

function SourceBadge({ source }: { source: "sdk" | "jsonl" }) {
  const { t } = useI18n();
  return (
    <span className={`context-status-source-badge source-${source}`}>
      {source === "sdk"
        ? t("contextBreakdownSourceSDK")
        : t("contextBreakdownSourceEstimate")}
    </span>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}
