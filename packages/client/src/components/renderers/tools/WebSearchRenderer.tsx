import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { ToolRenderer, WebSearchInput, WebSearchResult } from "./types";

function getCodexWebSearchActionLabel(action: unknown): string | undefined {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return undefined;
  }

  const record = action as Record<string, unknown>;
  const actionType =
    typeof record.type === "string" && record.type.trim()
      ? record.type.trim()
      : undefined;

  if (actionType === "search") {
    const query =
      typeof record.query === "string" && record.query.trim()
        ? record.query.trim()
        : Array.isArray(record.queries) && typeof record.queries[0] === "string"
          ? record.queries[0].trim()
          : undefined;
    return query ? `Search: ${query}` : "Search";
  }

  if (actionType === "open_page" || actionType === "openPage") {
    const url =
      typeof record.url === "string" && record.url.trim()
        ? record.url.trim()
        : undefined;
    return url ? `Open page: ${url}` : "Open page";
  }

  if (actionType === "find_in_page" || actionType === "findInPage") {
    const pattern =
      typeof record.pattern === "string" && record.pattern.trim()
        ? record.pattern.trim()
        : undefined;
    const url =
      typeof record.url === "string" && record.url.trim()
        ? record.url.trim()
        : undefined;
    const target = [pattern, url].filter(Boolean).join(" @ ");
    return target ? `Find in page: ${target}` : "Find in page";
  }

  return actionType;
}

function getWebSearchDisplayText(value: WebSearchInput | WebSearchResult) {
  const record = value as WebSearchInput & WebSearchResult;
  return (
    record.query?.trim() ||
    record.codexActionLabel?.trim() ||
    getCodexWebSearchActionLabel(record.action ?? record.codexAction) ||
    "Web search"
  );
}

function isRedundantSearchActionLabel(
  actionLabel: string | undefined,
  query: string | undefined,
) {
  if (!actionLabel || !query) return false;
  return actionLabel === `Search: ${query}`;
}

/**
 * WebSearch tool use - shows search query
 */
function WebSearchToolUse({ input }: { input: WebSearchInput }) {
  const displayText = getWebSearchDisplayText(input);
  return (
    <div className="websearch-tool-use">
      <span className="websearch-query">{displayText}</span>
    </div>
  );
}

/**
 * WebSearch tool result - shows search results as links
 */
function WebSearchToolResult({
  result,
  isError,
}: {
  result: WebSearchResult;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("WebSearch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebSearch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebSearch");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="websearch-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Search failed"}
      </div>
    );
  }

  if (!result) {
    return <div className="websearch-empty">No results</div>;
  }

  // Flatten results from potentially nested structure
  const allResults =
    result.results?.flatMap((r) => r.content || []).filter(Boolean) || [];
  const displayText = getWebSearchDisplayText(result);
  const queryText = result.query?.trim();
  const actionLabel =
    result.codexActionLabel?.trim() ||
    getCodexWebSearchActionLabel(result.codexAction);
  const showActionLabel = !isRedundantSearchActionLabel(actionLabel, queryText);

  return (
    <div className="websearch-result">
      <div className="websearch-header">
        <span className="websearch-query-display">
          {queryText ? `"${queryText}"` : displayText}
        </span>
        {result.durationSeconds !== undefined && (
          <span className="badge">{result.durationSeconds.toFixed(2)}s</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
      </div>
      {actionLabel && actionLabel !== displayText && showActionLabel && (
        <div className="websearch-action">{actionLabel}</div>
      )}
      {allResults.length > 0 ? (
        <ul className="websearch-links">
          {allResults.map((item, i) => (
            <li key={`${item.url}-${i}`} className="websearch-link-item">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="websearch-link"
              >
                {item.title}
              </a>
              <span className="websearch-url">{item.url}</span>
            </li>
          ))}
        </ul>
      ) : actionLabel ? null : (
        <div className="websearch-empty">No results found</div>
      )}
    </div>
  );
}

export const webSearchRenderer: ToolRenderer<WebSearchInput, WebSearchResult> =
  {
    tool: "WebSearch",

    renderToolUse(input, _context) {
      return <WebSearchToolUse input={input as WebSearchInput} />;
    },

    renderToolResult(result, isError, _context) {
      return (
        <WebSearchToolResult
          result={result as WebSearchResult}
          isError={isError}
        />
      );
    },

    getUseSummary(input) {
      return getWebSearchDisplayText(input as WebSearchInput);
    },

    getResultSummary(result, isError) {
      if (isError) return "Error";
      const r = result as WebSearchResult;
      const count = r?.results?.flatMap((res) => res.content || []).length || 0;
      if (count === 0 && (r?.codexActionLabel || r?.codexAction)) {
        return getWebSearchDisplayText(r);
      }
      return `${count} results`;
    },
  };
