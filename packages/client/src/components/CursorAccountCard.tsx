import type { CursorAccountResponse, ProviderInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type ApiError, api } from "../api/client";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";
import { Skeleton } from "./Skeleton";

const RETRY_DELAYS_MS = [1_500, 3_000, 6_000];

interface Props {
  providerInfo?: Pick<ProviderInfo, "authenticated" | "user">;
  unavailableReason?: ProviderInfo["unavailableReason"];
  onRefresh?: () => void | Promise<void>;
}

export function CursorAccountCard({
  providerInfo,
  unavailableReason,
  onRefresh,
}: Props) {
  const { t, locale } = useI18n();
  const headingId = useId();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [response, setResponse] = useState<CursorAccountResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async function loadAccount(
    fresh = false,
    attempt = 0,
  ) {
    if (inFlight.current) return;
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    inFlight.current = true;
    const current = ++generation.current;
    let retryable = false;
    setLoading(true);
    setCopied(false);
    try {
      const next = await api.getCursorAccount({ fresh });
      if (generation.current === current) {
        setResponse(next);
        setFailed(false);
        retryable =
          next.error === "request-failed" ||
          next.error === "status-unavailable";
      }
    } catch (error) {
      if (generation.current === current) {
        setFailed(true);
        const status = (error as Partial<ApiError> | null)?.status;
        retryable = status === undefined || status === 408 || status >= 500;
      }
    } finally {
      if (generation.current === current) {
        setLoading(false);
        inFlight.current = false;
        const delay = RETRY_DELAYS_MS[attempt];
        if (retryable && delay !== undefined) {
          retryTimer.current = setTimeout(() => {
            // Bypass an error cached by the server, but never poll indefinitely.
            void loadAccount(true, attempt + 1);
          }, delay);
        }
      }
    }
  }, []);
  useEffect(() => {
    void load();
    const recover = () => {
      void load(true);
    };
    const unsubscribeReconnect = activityBus.on("reconnect", recover);
    const unsubscribeRefresh = activityBus.on("refresh", recover);
    window.addEventListener("online", recover);
    return () => {
      generation.current += 1;
      inFlight.current = false;
      if (retryTimer.current !== null) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      unsubscribeReconnect();
      unsubscribeRefresh();
      window.removeEventListener("online", recover);
    };
  }, [load]);

  // Provider discovery already knows the CLI identity. A failed usage request
  // must not erase it; an explicit account response (including sign-out) wins.
  const identity = response ?? providerInfo;
  const usage = response?.usage;
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
      new Date(value),
    );
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
    }).format(value);
  const error = failed ? "request-failed" : response?.error;
  const errorText = failed
    ? t("cursorAccountConnectionFailed")
    : error === "status-unavailable"
      ? t("cursorAccountStatusCheckFailed")
      : error === "not-installed"
        ? t("cursorAccountNotInstalled")
        : error === "not-authenticated"
          ? t("cursorAccountNotAuthenticated")
          : error === "auth-expired"
            ? t("cursorAccountAuthExpired")
            : error === "credentials-unavailable"
              ? t("cursorAccountCredentialsUnavailable")
              : error === "rate-limited"
                ? t("cursorAccountRateLimited")
                : error === "usage-unavailable"
                  ? t("cursorAccountUsageUnavailable")
                  : error
                    ? t("cursorAccountRequestFailed")
                    : null;
  const windows = [
    {
      key: "total",
      label: t("cursorUsageIncluded"),
      value: usage?.totalPercentUsed,
    },
    {
      key: "cursor",
      label: t("cursorUsageCursorModels"),
      value: usage?.cursorPercentUsed,
    },
    {
      key: "api",
      label: t("cursorUsageOtherModels"),
      value: usage?.apiPercentUsed,
    },
  ].filter(
    (window): window is { key: string; label: string; value: number } =>
      typeof window.value === "number",
  );

  const summary = [
    response?.plan ? t("cursorAccountPlan", { plan: response.plan }) : null,
    usage?.unlimited
      ? t("cursorUsageUnlimited")
      : usage?.totalPercentUsed !== undefined
        ? t("cursorAccountUsageSummary", {
            percent: percent(usage.totalPercentUsed),
          })
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const accountState =
    identity && response?.error !== "status-unavailable"
      ? identity.authenticated
        ? t("cursorAccountConnected")
        : t("cursorAccountNotConnected")
      : t("cursorAccountStatusUnknown");

  return (
    <>
      <section
        className="new-session-cursor-account-section"
        aria-labelledby={headingId}
        aria-busy={loading}
      >
        <h3 id={headingId}>{t("cursorAccountHeading")}</h3>
        <p className="new-session-section-hint">{t("cursorAccountSource")}</p>
        <div
          className={`cursor-account-summary${identity?.authenticated ? " selected" : ""}`}
        >
          <span
            className="mode-option-dot cursor-account-dot"
            aria-hidden="true"
          />
          <div className="mode-option-content">
            <span className="mode-option-label">
              {loading && !identity ? (
                <Skeleton width="16ch" />
              ) : (
                (identity?.user?.email ?? identity?.user?.name ?? "Cursor CLI")
              )}
            </span>
            <span className="mode-option-desc">
              {loading && !identity ? (
                <Skeleton width="12ch" />
              ) : (
                summary || accountState
              )}
            </span>
          </div>
        </div>
      </section>
      <section className="codex-usage-card codex-usage-card-collapsible cursor-usage-card">
        <h3 className="codex-usage-disclosure-heading">
          <button
            type="button"
            className="codex-usage-disclosure"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{t("cursorAccountTitle")}</span>
            <span className="codex-usage-disclosure-action">
              {expanded
                ? t("newSessionCodexUsageCollapse")
                : t("newSessionCodexUsageExpand")}
              <svg
                className="codex-usage-disclosure-chevron"
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
            </span>
          </button>
        </h3>
        <div
          id={detailsId}
          className="codex-usage-details"
          hidden={!expanded}
          aria-busy={loading}
        >
          <div className="codex-account-actions">
            <button
              type="button"
              className="codex-usage-refresh"
              disabled={loading}
              onClick={async () => {
                await load(true);
                await onRefresh?.();
              }}
            >
              {loading
                ? t("cursorAccountRefreshing")
                : t("cursorAccountRefresh")}
            </button>
            <a
              className="codex-usage-refresh"
              href="https://cursor.com/dashboard?tab=usage"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("cursorAccountDashboard")}
            </a>
            {(error === "not-authenticated" || error === "auth-expired") && (
              <button
                type="button"
                className="codex-usage-refresh"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText("agent login");
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied
                  ? t("cursorAccountCopied")
                  : t("cursorAccountCopyLogin")}
              </button>
            )}
          </div>
          {usage?.unlimited ? (
            <p className="codex-usage-state">{t("cursorUsageUnlimited")}</p>
          ) : (
            windows.length > 0 && (
              <div className="codex-usage-windows">
                {windows.map((window) => (
                  <div key={window.key} className="codex-usage-window">
                    <div className="codex-usage-window-heading">
                      <span>{window.label}</span>
                      <strong>
                        {t("cursorUsageUsed", {
                          percent: percent(window.value),
                        })}
                      </strong>
                    </div>
                    <div
                      className="codex-usage-progress-track"
                      role="progressbar"
                      tabIndex={0}
                      aria-label={window.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(100, Math.max(0, window.value))}
                      aria-valuetext={t("cursorUsageUsed", {
                        percent: percent(window.value),
                      })}
                    >
                      <span
                        className="codex-usage-progress-value"
                        style={{
                          width: `${Math.min(100, Math.max(0, window.value))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {usage?.billingCycleEnd && (
            <p className="codex-usage-state">
              {t("cursorUsageReset", {
                date: formatDate(usage.billingCycleEnd),
              })}
            </p>
          )}
          {usage?.onDemand && (
            <p className="codex-usage-state">
              {usage.onDemand.enabled
                ? usage.onDemand.usedUsd !== undefined
                  ? t("cursorUsageOnDemand", {
                      amount: money(usage.onDemand.usedUsd),
                    })
                  : t("cursorUsageOnDemandEnabled")
                : t("cursorUsageOnDemandDisabled")}
              {usage.onDemand.enabled &&
                usage.onDemand.limitUsd !== undefined &&
                usage.onDemand.limitUsd > 0 &&
                ` · ${t("cursorUsageOnDemandLimit", { amount: money(usage.onDemand.limitUsd) })}`}
            </p>
          )}
          {response?.fetchedAt && (
            <p className="codex-usage-state">
              <time dateTime={response.fetchedAt}>
                {t("cursorUsageUpdated", {
                  time: new Intl.DateTimeFormat(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(response.fetchedAt)),
                })}
              </time>
            </p>
          )}
        </div>
      </section>
      {unavailableReason && (
        <p className="codex-usage-state" role="status">
          {unavailableReason === "runtime-update-required"
            ? t("cursorRuntimeUpdateRequired")
            : t("cursorRuntimeUnavailable")}
        </p>
      )}
      {(errorText || response?.stale || (failed && usage)) && (
        <div aria-live="polite">
          {errorText && <p className="codex-usage-state">{errorText}</p>}
          {(response?.stale || (failed && usage)) && (
            <p className="codex-usage-state">{t("cursorUsageStale")}</p>
          )}
          {errorText && (
            <button
              type="button"
              className="codex-usage-refresh"
              disabled={loading}
              onClick={async () => {
                await load(true);
                await onRefresh?.();
              }}
            >
              {loading ? t("cursorAccountRefreshing") : t("cursorAccountRetry")}
            </button>
          )}
        </div>
      )}
    </>
  );
}
