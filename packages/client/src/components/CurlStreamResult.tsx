import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import type { CurlStreamPreview } from "../lib/curlStreamPreview";

function StreamText({
  children,
  label,
  code = false,
}: { children: string; label: string; code?: boolean }) {
  const element = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (children && follow.current && element.current)
      element.current.scrollTop = element.current.scrollHeight;
  }, [children]);
  return (
    <pre
      ref={element}
      className={`curl-result${code ? "" : " curl-stream-text"}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable output must be keyboard-scrollable.
      tabIndex={0}
      aria-label={label}
      onScroll={() => {
        const node = element.current;
        if (node)
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      }}
    >
      {children}
    </pre>
  );
}

export function CurlStreamResult({ preview }: { preview: CurlStreamPreview }) {
  const { t } = useI18n();
  return (
    <div className="curl-stream-result">
      <p className="curl-muted">
        {t("curlStreamEvents", { count: preview.events })}
      </p>
      {preview.error && (
        <p className="curl-error" role="alert">
          {preview.error}
        </p>
      )}
      {preview.reasoning && (
        <details className="curl-stream-detail">
          <summary>{t("curlReasoning")}</summary>
          <StreamText label={t("curlReasoning")}>
            {preview.reasoning}
          </StreamText>
        </details>
      )}
      {preview.text && (
        <StreamText label={t("curlStreamPreview")}>{preview.text}</StreamText>
      )}
      {preview.tools.map((tool) => (
        <details key={tool.id} className="curl-stream-detail" open>
          <summary>
            {t("curlToolCall")}: {tool.name || tool.id}
          </summary>
          <StreamText label={t("curlToolCall")} code>
            {tool.arguments || t("curlToolArgumentsWaiting")}
          </StreamText>
        </details>
      ))}
      {Object.keys(preview.usage).length > 0 && (
        <details className="curl-stream-detail">
          <summary>{t("curlUsage")}</summary>
          <StreamText label={t("curlUsage")} code>
            {JSON.stringify(preview.usage, null, 2)}
          </StreamText>
        </details>
      )}
      {!preview.text &&
        !preview.reasoning &&
        !preview.tools.length &&
        !preview.error && <p className="curl-muted">{t("curlStreamNoText")}</p>}
      <p className="curl-muted">{t("curlStreamPreviewHint")}</p>
    </div>
  );
}
