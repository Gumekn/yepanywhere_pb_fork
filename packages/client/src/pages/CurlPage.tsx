import {
  CURL_TIMEOUT_DEFAULT_SECONDS,
  CURL_TIMEOUT_MAX_SECONDS,
  type CurlCollection,
  type CurlCollections,
  CurlCommandError,
  type CurlHistoryEntry,
  type CurlRequest,
  type CurlResponse,
  type CurlTemplate,
  parseCurlCommand,
  serializeCurlRequest,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJSON } from "../api/client";
import { startCurlExecution } from "../api/curl";
import { CurlStreamResult } from "../components/CurlStreamResult";
import { PageHeader } from "../components/PageHeader";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { writeClipboardText } from "../lib/clipboard";
import { type CurlPageDraft, completeCurlDraft } from "../lib/curlDraft";
import { CurlStreamProjector } from "../lib/curlStreamPreview";
import { generateUUID } from "../lib/uuid";
import "../styles/curl.css";

const EMPTY_REQUEST: CurlRequest = {
  url: "",
  method: "GET",
  headers: [],
  body: null,
  noProxy: null,
  proxy: null,
  basicAuth: null,
  followRedirects: false,
  insecure: false,
  compressed: false,
  timeoutSeconds: CURL_TIMEOUT_DEFAULT_SECONDS,
};
const EXAMPLE = serializeCurlRequest({
  ...EMPTY_REQUEST,
  url: "https://api.example.com/v1/chat/completions",
  method: "POST",
  headers: [
    "Authorization: Bearer YOUR_API_KEY",
    "Content-Type: application/json",
  ],
  body: JSON.stringify(
    {
      model: "your-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      max_tokens: 2048,
    },
    null,
    2,
  ),
});
const isBearerHeader = (header: string) =>
  /^authorization:\s*bearer(?:\s|$)/i.test(header);
type MessageKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];

function editableHeaders(request: CurlRequest) {
  const matches = request.headers.filter((header) =>
    /^authorization:/i.test(header),
  );
  const bearer =
    matches.length === 1 && isBearerHeader(matches[0] ?? "")
      ? (matches[0]?.replace(/^authorization:\s*bearer\s*/i, "") ?? "")
      : "";
  // Preserve duplicate/empty Authorization headers in their original order.
  const index = bearer ? request.headers.findIndex(isBearerHeader) : -1;
  const headers = request.headers.filter((_, i) => i !== index);
  return {
    headers: headers.join("\n"),
    bearer,
  };
}

function requestOrEmpty(command: string): CurlRequest {
  try {
    return parseCurlCommand(command);
  } catch {
    return EMPTY_REQUEST;
  }
}

function requestLabel(entry: CurlTemplate) {
  try {
    const request = parseCurlCommand(entry.command);
    const url = new URL(request.url);
    return { method: request.method, url: `${url.host}${url.pathname}` };
  } catch {
    return { method: "cURL", url: "" };
  }
}

export function CurlPage() {
  const { t, locale } = useI18n();
  const { openSidebar, isWideScreen, curlDraft } = useNavigationLayout();
  const fallbackDraft = useRef<CurlPageDraft | undefined>(undefined);
  const draft = curlDraft ?? fallbackDraft;
  const initialDraft = useRef(draft.current);
  const [initialRequest] = useState(() =>
    requestOrEmpty(initialDraft.current?.command ?? ""),
  );
  useHideSplashOnReady(true);
  // Both editors are visible; the last edited source determines the command.
  const [inputSource, setInputSource] = useState<"curl" | "form">("curl");
  const [raw, setRaw] = useState(initialDraft.current?.command ?? "");
  const [form, setForm] = useState<CurlRequest>(initialRequest);
  const [headers, setHeaders] = useState(
    () => editableHeaders(initialRequest).headers,
  );
  const [bearer, setBearer] = useState(
    () => editableHeaders(initialRequest).bearer,
  );
  const [showKey, setShowKey] = useState(false);
  const [commandCopyResult, setCommandCopyResult] = useState<{
    command: string;
    status: "copied" | "failed";
  }>();
  const [name, setName] = useState(initialDraft.current?.name ?? "");
  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialDraft.current?.selectedId,
  );
  const [selectedCollection, setSelectedCollection] = useState<
    CurlCollection | undefined
  >(initialDraft.current?.selectedCollection);
  const templateId =
    selectedCollection === "templates" ? selectedId : undefined;
  const baseline = useRef(
    initialDraft.current?.baseline ?? { command: "", name: "" },
  );
  const [entries, setEntries] = useState<CurlHistoryEntry[]>([]);
  const [templates, setTemplates] = useState<CurlTemplate[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [runId, setRunId] = useState<string | undefined>(
    initialDraft.current?.pending?.id,
  );
  const [cancelling, setCancelling] = useState(false);
  const [response, setResponse] = useState<CurlResponse | undefined>(
    initialDraft.current?.response,
  );
  const [responseTab, setResponseTab] = useState<
    "preview" | "body" | "headers"
  >("preview");
  const projector = useRef(new CurlStreamProjector());
  const [pretty, setPretty] = useState(true);
  const actionPending = useRef(Boolean(initialDraft.current?.pending));
  const alive = useRef(true);
  const timeoutLimit = useRef(CURL_TIMEOUT_DEFAULT_SECONDS);
  const historyRevision = useRef(0);
  const busy = saving || Boolean(runId);
  const command =
    inputSource === "curl"
      ? raw
      : serializeCurlRequest({
          ...form,
          headers: [
            ...headers.split("\n").filter((h) => h.trim()),
            ...(bearer ? [`Authorization: Bearer ${bearer}`] : []),
          ],
        });
  const dirty =
    command !== baseline.current.command || name !== baseline.current.name;
  const parseResult = useMemo(() => {
    try {
      return { request: parseCurlCommand(command) };
    } catch (error) {
      return {
        error: error instanceof CurlCommandError ? error.code : "command",
      };
    }
  }, [command]);
  const invalidSource = Boolean(
    inputSource === "curl" && raw.trim() && parseResult.error,
  );

  const commandCopyStatus =
    commandCopyResult?.command === command ? commandCopyResult.status : "idle";

  const message = useCallback(
    (error: unknown) => {
      const code =
        error instanceof CurlCommandError
          ? `curlInvalid_${error.code}`
          : error instanceof Error
            ? error.message
            : "";
      // Map known API errors only; never echo arbitrary response bodies or keys.
      if (code === "curlInvalid_limit")
        return t(code, { max: CURL_TIMEOUT_MAX_SECONDS });
      if (/^curl(?:Error|Invalid)_[a-zA-Z]+$/.test(code))
        return t(code as MessageKey);
      return t("curlError_request");
    },
    [t],
  );

  const loadHistory = useCallback(async () => {
    const revision = historyRevision.current;
    setLoading(true);
    setListError(undefined);
    try {
      const result = await fetchJSON<CurlCollections>("/curl");
      if (alive.current && revision === historyRevision.current) {
        setEntries(result.entries);
        setTemplates(result.templates);
      }
    } catch (error) {
      if (alive.current) setListError(message(error));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    draft.current = {
      command,
      name,
      selectedId,
      selectedCollection,
      baseline: baseline.current,
      response,
      pending: draft.current?.pending,
    };
  }, [command, name, selectedId, selectedCollection, response, draft]);

  // The transport belongs to the draft; a page only subscribes while visible.
  useEffect(() => {
    if (!runId) return;
    const pending = draft.current?.pending;
    if (!pending || pending.id !== runId) return;
    return pending.execution.subscribe((next) => {
      if (draft.current?.pending?.id === runId) draft.current.response = next;
      setResponse(next);
    });
  }, [runId, draft]);

  // Rejoin a request when returning from another page while it is still running.
  useEffect(() => {
    const initial = initialDraft.current;
    if (!initial?.pending) return;
    const pending = initial.pending;
    let active = true;
    pending.result
      .then((result) => {
        if (!active) return;
        historyRevision.current++;
        setEntries((current) =>
          [
            result.entry,
            ...current.filter((entry) => entry.id !== result.entry.id),
          ].slice(0, 100),
        );
        const completed = completeCurlDraft(initial, result);
        setSelectedId(completed.selectedId);
        setSelectedCollection(completed.selectedCollection);
        setName(result.entry.name);
        baseline.current = completed.baseline;
        setResponse(result.response);
        if (!result.historySaved) setNotice(t("curlHistoryPartial"));
      })
      .catch((error) => {
        if (active) setError(message(error));
      })
      .finally(() => {
        if (active) {
          actionPending.current = false;
          setRunId(undefined);
          setCancelling(false);
        }
      });
    return () => {
      active = false;
    };
  }, [message, t]);

  useEffect(() => {
    alive.current = true;
    void loadHistory();
    return () => {
      alive.current = false;
    };
  }, [loadHistory]);

  // Warn only when leaving an unsaved editor. Keys are not copied to localStorage.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function fillForm(request: CurlRequest) {
    const edit = editableHeaders(request);
    setForm(request);
    setHeaders(edit.headers);
    setBearer(edit.bearer);
    setShowKey(false);
  }

  function updateCommand(value: string) {
    setRaw(value);
    setInputSource("curl");
    fillForm(requestOrEmpty(value));
    setError(undefined);
  }

  function updateForm(request: CurlRequest) {
    setForm(request);
    setInputSource("form");
    setError(undefined);
  }

  function canReplace() {
    return !dirty || window.confirm(t("curlDiscard"));
  }

  function openEntry(entry?: CurlTemplate, collection?: CurlCollection) {
    if (actionPending.current || !canReplace()) return;
    setSelectedId(entry?.id);
    setSelectedCollection(collection);
    setName(entry?.name ?? "");
    updateCommand(entry?.command ?? "");
    baseline.current = {
      command: entry?.command ?? "",
      name: entry?.name ?? "",
    };
    setResponse(undefined);
    projector.current = new CurlStreamProjector();
    setError(undefined);
    setNotice(undefined);
    setShowKey(false);
  }

  function rememberTemplate(entry: CurlTemplate) {
    historyRevision.current++;
    setTemplates((current) => [
      entry,
      ...current.filter((item) => item.id !== entry.id),
    ]);
    setSelectedId(entry.id);
    setSelectedCollection("templates");
    baseline.current = { command: entry.command, name: entry.name };
    if (draft.current) {
      draft.current.baseline = baseline.current;
      draft.current.selectedId = entry.id;
      draft.current.selectedCollection = "templates";
      draft.current.name = entry.name;
    }
  }

  async function save(asCopy = false) {
    if (actionPending.current) return;
    actionPending.current = true;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      parseCurlCommand(command);
      const id = asCopy ? undefined : templateId;
      const result = await fetchJSON<{ entry: CurlTemplate }>(
        id ? `/curl/templates/${id}` : "/curl/templates",
        {
          method: id ? "PUT" : "POST",
          body: JSON.stringify({ name, command }),
        },
      );
      if (!alive.current) return;
      rememberTemplate(result.entry);
      setName(result.entry.name);
      setNotice(t("curlSaved"));
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      actionPending.current = false;
      if (alive.current) setSaving(false);
    }
  }

  async function execute() {
    if (actionPending.current) return;
    actionPending.current = true;
    const id = generateUUID();
    setRunId(id);
    setCancelling(false);
    setResponse(undefined);
    setResponseTab("preview");
    projector.current = new CurlStreamProjector();
    setError(undefined);
    setNotice(undefined);
    try {
      parseCurlCommand(command);
      const execution = startCurlExecution(name, command, id);
      const resultPromise = execution.result;
      const startedDraft: CurlPageDraft = {
        command,
        name,
        selectedId,
        selectedCollection,
        baseline: baseline.current,
        response: execution.response,
        pending: { id, result: resultPromise, execution },
      };
      draft.current = startedDraft;
      // Keep partial data in memory even while this page is not mounted.
      const unsubscribe = execution.subscribe((next) => {
        if (draft.current?.pending?.id === id) draft.current.response = next;
      });
      void resultPromise.then(unsubscribe, unsubscribe);
      const result = await resultPromise;
      // Complete the in-memory workspace even if this page was unmounted.
      const completed = completeCurlDraft(startedDraft, result);
      draft.current = completed;
      if (!alive.current) return;
      historyRevision.current++;
      setEntries((current) =>
        [
          result.entry,
          ...current.filter((entry) => entry.id !== result.entry.id),
        ].slice(0, 100),
      );
      setSelectedId(completed.selectedId);
      setSelectedCollection(completed.selectedCollection);
      baseline.current = completed.baseline;
      setName(result.entry.name);
      setResponse(result.response);
      if (!result.historySaved) setNotice(t("curlHistoryPartial"));
    } catch (error) {
      if (alive.current) {
        setError(message(error));
        void loadHistory();
      }
    } finally {
      if (draft.current?.pending?.id === id) draft.current.pending = undefined;
      actionPending.current = false;
      if (alive.current) {
        setRunId(undefined);
        setCancelling(false);
      }
    }
  }

  async function cancel() {
    if (!runId) return;
    setCancelling(true);
    try {
      const result = await fetchJSON<{ cancelled: boolean }>(
        `/curl/cancel/${runId}`,
        { method: "POST" },
      );
      if (!result.cancelled) setCancelling(false);
    } catch (error) {
      setError(message(error));
      setCancelling(false);
    }
  }

  async function remove(entry: CurlTemplate, collection: CurlCollection) {
    if (
      actionPending.current ||
      !window.confirm(
        t(
          collection === "templates"
            ? "curlDeleteTemplateConfirm"
            : "curlDeleteConfirm",
        ),
      )
    )
      return;
    actionPending.current = true;
    setSaving(true);
    try {
      await fetchJSON(`/curl/${collection}/${entry.id}`, { method: "DELETE" });
      historyRevision.current++;
      if (collection === "templates")
        setTemplates((current) =>
          current.filter((item) => item.id !== entry.id),
        );
      else
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      if (selectedId === entry.id && selectedCollection === collection) {
        setSelectedId(undefined);
        setSelectedCollection(undefined);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      actionPending.current = false;
      setSaving(false);
    }
  }

  async function copy(text: string) {
    try {
      await writeClipboardText(text);
      setNotice(t("curlCopied"));
    } catch {
      setError(t("curlCopyFailed"));
    }
  }

  async function copyCommand() {
    if (!parseResult.request) return;
    try {
      await writeClipboardText(serializeCurlRequest(parseResult.request));
      setCommandCopyResult({ command, status: "copied" });
    } catch {
      setCommandCopyResult({ command, status: "failed" });
    }
  }

  const displayedBody = useMemo(() => {
    if (!response || !pretty) return response?.body ?? "";
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }, [response, pretty]);
  const preview = useMemo(
    () =>
      projector.current.update(response?.body ?? "", response?.headers ?? ""),
    [response],
  );
  const activeResponseTab =
    responseTab === "preview" && !preview.isSse ? "body" : responseTab;
  const previewCopy = [
    preview.reasoning,
    preview.text,
    preview.error,
    ...preview.tools.map(
      (tool) => `${tool.name || tool.id}\n${tool.arguments}`,
    ),
    Object.keys(preview.usage).length
      ? JSON.stringify(preview.usage, null, 2)
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const jsonBody = useMemo(() => {
    try {
      const body: unknown = JSON.parse(form.body ?? "");
      return body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }, [form.body]);
  const currentHostname = useMemo(() => {
    try {
      const url = new URL(form.url);
      return ["http:", "https:"].includes(url.protocol)
        ? url.hostname.replace(/^\[|\]$/g, "")
        : "";
    } catch {
      return "";
    }
  }, [form.url]);
  const collections = useMemo(() => {
    const groups: {
      kind: CurlCollection;
      items: (CurlTemplate | CurlHistoryEntry)[];
    }[] = [
      { kind: "templates", items: templates },
      { kind: "history", items: entries },
    ];
    return groups.map(({ kind, items }) => ({
      kind,
      total: items.length,
      items: items
        .map((entry) => ({ entry, label: requestLabel(entry) }))
        .filter(({ entry, label }) =>
          `${entry.name} ${label.url} ${label.method}`
            .toLowerCase()
            .includes(filter.toLowerCase()),
        ),
    }));
  }, [templates, entries, filter]);

  return (
    <div className="main-content-wrapper curl-page">
      <PageHeader
        title={t("curlTitle")}
        onOpenSidebar={openSidebar}
        isWideScreen={isWideScreen}
      />
      <div className="curl-layout">
        <main className="curl-workspace">
          <div className="curl-toolbar">
            <p className="curl-muted">{t("curlDescription")}</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => openEntry()}
              disabled={busy}
            >
              {t("curlNew")}
            </button>
          </div>
          <section className="curl-editor" aria-label={t("curlRequest")}>
            <div className="curl-section-heading">
              <h2>{t("curlRequest")}</h2>
              <div className="curl-copy-command">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!parseResult.request}
                  onClick={() => void copyCommand()}
                  title={t("curlCopyCommandHint")}
                >
                  {t("curlCopyCommand")}
                </button>
                <span
                  role="status"
                  className={
                    commandCopyStatus === "failed" ? "curl-error" : "curl-muted"
                  }
                >
                  {commandCopyStatus === "copied"
                    ? t("curlCopied")
                    : commandCopyStatus === "failed"
                      ? t("curlCopyFailed")
                      : ""}
                </span>
              </div>
            </div>
            <fieldset disabled={busy} className="curl-fields">
              <label>
                {t("curlName")}
                <input
                  value={name}
                  maxLength={120}
                  placeholder={t("curlNamePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                {t("curlCommand")}
                <textarea
                  className="curl-code curl-command"
                  spellCheck={false}
                  rows={4}
                  value={command}
                  aria-invalid={Boolean(command.trim() && parseResult.error)}
                  aria-describedby="curl-command-hint"
                  placeholder={
                    "curl 'https://api.example.com/v1/chat/completions' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"model\":\"your-model\",\"messages\":[]}'"
                  }
                  onChange={(e) => {
                    updateCommand(e.target.value);
                  }}
                />
              </label>
              <div className="curl-inline">
                <span id="curl-command-hint" className="curl-muted">
                  {t(
                    invalidSource ? "curlDetailsUnavailable" : "curlImportHint",
                  )}
                </span>
                <button
                  type="button"
                  className="curl-text-button"
                  onClick={() => {
                    if (canReplace()) {
                      updateCommand(EXAMPLE);
                      setSelectedId(undefined);
                      setSelectedCollection(undefined);
                      setError(undefined);
                    }
                  }}
                >
                  {t("curlExample")}
                </button>
              </div>
              {command.trim() && parseResult.error && (
                <p className="curl-error" role="status">
                  {t(`curlInvalid_${parseResult.error}` as MessageKey, {
                    max: CURL_TIMEOUT_MAX_SECONDS,
                  })}
                </p>
              )}
              <fieldset className="curl-fields" disabled={invalidSource}>
                <div className="curl-url-row">
                  <label>
                    {t("curlMethod")}
                    <select
                      value={form.method}
                      onChange={(e) =>
                        updateForm({
                          ...form,
                          method: e.target.value,
                          ...(e.target.value === "HEAD" ? { body: null } : {}),
                        })
                      }
                    >
                      {[
                        ...new Set([
                          "GET",
                          "POST",
                          "PUT",
                          "PATCH",
                          "DELETE",
                          "HEAD",
                          "OPTIONS",
                          form.method,
                        ]),
                      ].map((method) => (
                        <option key={method}>{method}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    URL
                    <input
                      type="text"
                      inputMode="url"
                      spellCheck={false}
                      value={form.url}
                      placeholder="https://api.example.com/v1/chat/completions"
                      onChange={(e) =>
                        updateForm({ ...form, url: e.target.value })
                      }
                    />
                  </label>
                </div>
                <div className="curl-no-proxy-field">
                  <div className="curl-inline">
                    <label htmlFor="curl-no-proxy">{t("curlNoProxy")}</label>
                    <button
                      type="button"
                      className="curl-text-button"
                      disabled={!currentHostname}
                      onClick={() =>
                        updateForm({ ...form, noProxy: currentHostname })
                      }
                    >
                      {t("curlNoProxyUseHostname")}
                    </button>
                    <button
                      type="button"
                      className="curl-text-button"
                      disabled={form.noProxy === null}
                      onClick={() => updateForm({ ...form, noProxy: null })}
                    >
                      {t("curlNoProxyUseDefaults")}
                    </button>
                  </div>
                  <input
                    id="curl-no-proxy"
                    aria-describedby="curl-no-proxy-hint"
                    value={form.noProxy ?? ""}
                    placeholder="api.example.com,localhost"
                    spellCheck={false}
                    onChange={(e) =>
                      updateForm({ ...form, noProxy: e.target.value })
                    }
                  />
                  <p id="curl-no-proxy-hint" className="curl-muted">
                    {t(
                      form.noProxy === null
                        ? "curlNoProxyInherited"
                        : form.noProxy === ""
                          ? "curlNoProxyEmpty"
                          : "curlNoProxyHint",
                    )}
                  </p>
                </div>
                <label>
                  {t("curlApiKey")}
                  <span className="curl-key-row">
                    <input
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      value={bearer}
                      placeholder={t("curlKeyPlaceholder")}
                      onChange={(e) => {
                        setBearer(e.target.value);
                        setInputSource("form");
                      }}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      aria-pressed={showKey}
                      onClick={() => setShowKey(!showKey)}
                    >
                      {t(showKey ? "curlHide" : "curlShow")}
                    </button>
                  </span>
                </label>
                <label>
                  {t("curlHeaders")}
                  <textarea
                    className="curl-code"
                    spellCheck={false}
                    rows={3}
                    value={headers}
                    placeholder="Content-Type: application/json"
                    onChange={(e) => {
                      setHeaders(e.target.value);
                      setInputSource("form");
                    }}
                  />
                </label>
                <div className="curl-body-heading">
                  <label htmlFor="curl-body">{t("curlBody")}</label>
                  <button
                    type="button"
                    className="curl-text-button"
                    disabled={!form.body}
                    onClick={() => {
                      try {
                        updateForm({
                          ...form,
                          body: JSON.stringify(
                            JSON.parse(form.body ?? ""),
                            null,
                            2,
                          ),
                        });
                        setError(undefined);
                      } catch {
                        setError(t("curlInvalidJson"));
                      }
                    }}
                  >
                    {t("curlFormatJson")}
                  </button>
                </div>
                <textarea
                  id="curl-body"
                  className="curl-code curl-body"
                  spellCheck={false}
                  value={form.body ?? ""}
                  disabled={busy || form.method === "HEAD"}
                  onChange={(e) =>
                    updateForm({ ...form, body: e.target.value || null })
                  }
                />
                {jsonBody && (
                  <label className="curl-checkbox">
                    <input
                      type="checkbox"
                      checked={jsonBody.stream === true}
                      onChange={(e) =>
                        updateForm({
                          ...form,
                          body: JSON.stringify(
                            { ...jsonBody, stream: e.target.checked },
                            null,
                            2,
                          ),
                        })
                      }
                    />
                    {t("curlStreamRequest")}
                  </label>
                )}
                {jsonBody && (
                  <p className="curl-muted">{t("curlStreamRequestHint")}</p>
                )}
                <details className="curl-options" open>
                  <summary>{t("curlOptions")}</summary>
                  <div className="curl-fields">
                    <label>
                      {t("curlProxy")}
                      <input
                        value={form.proxy ?? ""}
                        placeholder="http://127.0.0.1:7890"
                        onChange={(e) =>
                          updateForm({ ...form, proxy: e.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      {t("curlTimeout", { max: CURL_TIMEOUT_MAX_SECONDS })}
                      <input
                        type="number"
                        min={1}
                        max={CURL_TIMEOUT_MAX_SECONDS}
                        step="any"
                        value={form.timeoutSeconds ?? ""}
                        disabled={form.timeoutSeconds === null}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === "") return;
                          const next = Number(raw);
                          if (!Number.isFinite(next)) return;
                          if (next > 0) timeoutLimit.current = next;
                          updateForm({
                            ...form,
                            timeoutSeconds: next === 0 ? null : next,
                          });
                        }}
                      />
                    </label>
                    <label className="curl-checkbox">
                      <input
                        type="checkbox"
                        checked={form.timeoutSeconds === null}
                        onChange={(e) => {
                          if (!e.target.checked) {
                            updateForm({
                              ...form,
                              timeoutSeconds: timeoutLimit.current,
                            });
                            return;
                          }
                          if (form.timeoutSeconds !== null)
                            timeoutLimit.current = form.timeoutSeconds;
                          updateForm({ ...form, timeoutSeconds: null });
                        }}
                      />
                      {t("curlTimeoutUnlimited")}
                    </label>
                    <label className="curl-checkbox">
                      <input
                        type="checkbox"
                        checked={form.followRedirects}
                        onChange={(e) =>
                          updateForm({
                            ...form,
                            followRedirects: e.target.checked,
                          })
                        }
                      />
                      {t("curlRedirects")}
                    </label>
                    <label className="curl-checkbox">
                      <input
                        type="checkbox"
                        checked={form.insecure}
                        onChange={(e) =>
                          updateForm({ ...form, insecure: e.target.checked })
                        }
                      />
                      {t("curlInsecure")}
                    </label>
                    <label className="curl-checkbox">
                      <input
                        type="checkbox"
                        checked={form.compressed}
                        onChange={(e) =>
                          updateForm({ ...form, compressed: e.target.checked })
                        }
                      />
                      {t("curlCompressed")}
                    </label>
                    {form.basicAuth !== null && (
                      <label>
                        {t("curlBasicAuth")}
                        <input
                          type="password"
                          autoComplete="off"
                          value={form.basicAuth}
                          onChange={(e) =>
                            updateForm({
                              ...form,
                              basicAuth: e.target.value || null,
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                </details>
              </fieldset>
            </fieldset>
            <div className="curl-actions">
              {runId ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void cancel()}
                  disabled={cancelling}
                >
                  {t(cancelling ? "curlCancelling" : "curlCancel")}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !parseResult.request}
                  onClick={() => void execute()}
                >
                  {t("curlSend")}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !parseResult.request}
                onClick={() => void save()}
              >
                {t(
                  saving
                    ? "curlSaving"
                    : templateId
                      ? "curlSaveChanges"
                      : "curlSave",
                )}
              </button>
              {templateId && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !parseResult.request}
                  onClick={() => void save(true)}
                >
                  {t("curlSaveCopy")}
                </button>
              )}
            </div>
            <p className="curl-muted curl-storage-note">
              {t("curlStorageNote")}
            </p>
            {error && (
              <p className="curl-error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="curl-muted" role="status">
                {notice}
              </p>
            )}
          </section>
          <section
            className="curl-response"
            aria-label={t("curlResponse")}
            aria-busy={Boolean(runId)}
          >
            <div className="curl-section-heading">
              <h2>{t("curlResponse")}</h2>
              {response && (
                <div className="curl-response-meta">
                  <span
                    className={
                      response.status >= 200 &&
                      response.status < 300 &&
                      !response.error
                        ? "curl-success"
                        : "curl-error"
                    }
                  >
                    {response.status
                      ? `HTTP ${response.status}`
                      : t("curlNoStatus")}
                  </span>
                  <span>{response.durationMs.toLocaleString(locale)} ms</span>
                  <span>{(response.size / 1024).toFixed(1)} KB</span>
                </div>
              )}
            </div>
            {runId && (
              <p className="curl-muted" role="status">
                {t(response?.body ? "curlStreaming" : "curlRunning")}
              </p>
            )}
            {!response ? (
              !runId && <p className="curl-empty">{t("curlResponseEmpty")}</p>
            ) : (
              <>
                {response.error && (
                  <p className="curl-error" role="alert">
                    {t(`curlRun_${response.error}`)}
                  </p>
                )}
                <div className="curl-response-tools">
                  <div
                    className="curl-switch"
                    role="group"
                    aria-label={t("curlResponseView")}
                  >
                    {preview.isSse && (
                      <button
                        type="button"
                        aria-pressed={activeResponseTab === "preview"}
                        onClick={() => setResponseTab("preview")}
                      >
                        {t("curlStreamPreview")}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-pressed={activeResponseTab === "body"}
                      onClick={() => setResponseTab("body")}
                    >
                      {t(preview.isSse ? "curlRawEvents" : "curlResponseBody")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={activeResponseTab === "headers"}
                      onClick={() => setResponseTab("headers")}
                    >
                      {t("curlHeaders")}
                    </button>
                  </div>
                  {activeResponseTab === "body" && !preview.isSse && (
                    <label className="curl-checkbox">
                      <input
                        type="checkbox"
                        checked={pretty}
                        onChange={(e) => setPretty(e.target.checked)}
                      />
                      {t("curlPretty")}
                    </label>
                  )}
                  <button
                    type="button"
                    className="curl-text-button"
                    onClick={() =>
                      void copy(
                        activeResponseTab === "preview"
                          ? previewCopy
                          : activeResponseTab === "body"
                            ? displayedBody
                            : response.headers,
                      )
                    }
                  >
                    {t("curlCopyResponse")}
                  </button>
                </div>
                {activeResponseTab === "preview" ? (
                  <CurlStreamResult preview={preview} />
                ) : (
                  /* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable response content must be keyboard-scrollable. */
                  <pre className="curl-result" tabIndex={0}>
                    {(activeResponseTab === "body"
                      ? displayedBody
                      : response.headers) || t("curlEmptyBody")}
                  </pre>
                )}
              </>
            )}
          </section>
        </main>
        <aside className="curl-history" aria-label={t("curlCollections")}>
          <input
            type="search"
            aria-label={t("curlSearch")}
            placeholder={t("curlSearch")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {loading && (
            <p className="curl-muted" role="status">
              {t("curlLoading")}
            </p>
          )}
          {listError && (
            <div role="alert">
              <p className="curl-error">{listError}</p>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void loadHistory()}
              >
                {t("curlRetry")}
              </button>
            </div>
          )}
          {collections.map(({ kind, total, items }) => (
            <section
              key={kind}
              className="curl-collection"
              aria-label={t(
                kind === "templates" ? "curlTemplates" : "curlHistory",
              )}
            >
              <div className="curl-section-heading">
                <h2>
                  {t(kind === "templates" ? "curlTemplates" : "curlHistory")}
                </h2>
                <span className="curl-muted">
                  {total}
                  {kind === "history" ? " / 100" : ""}
                </span>
              </div>
              {!loading && !listError && items.length === 0 && (
                <p className="curl-empty">
                  {t(
                    filter
                      ? "curlNoMatches"
                      : kind === "templates"
                        ? "curlTemplatesEmpty"
                        : "curlHistoryEmpty",
                  )}
                </p>
              )}
              <ol
                className={`curl-history-list${kind === "templates" ? " curl-template-list" : ""}`}
              >
                {items.map(({ entry, label }) => (
                  <li
                    key={entry.id}
                    className={
                      selectedId === entry.id && selectedCollection === kind
                        ? "is-selected"
                        : ""
                    }
                  >
                    <button
                      type="button"
                      className="curl-history-open"
                      disabled={busy}
                      aria-current={
                        selectedId === entry.id && selectedCollection === kind
                          ? "true"
                          : undefined
                      }
                      onClick={() => openEntry(entry, kind)}
                    >
                      <span className="curl-history-title">
                        {entry.name || label.url || t("curlUntitled")}
                      </span>
                      <span className="curl-history-url">
                        {label.method} {label.url}
                      </span>
                      <span className="curl-history-meta">
                        <time dateTime={entry.updatedAt}>
                          {new Date(entry.updatedAt).toLocaleString(locale, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        {kind === "history" && (
                          <span>
                            {"run" in entry && entry.run
                              ? entry.run.error
                                ? t(`curlRunLabel_${entry.run.error}`)
                                : `HTTP ${entry.run.status}`
                              : t("curlRunUnfinished")}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="curl-history-delete"
                      disabled={busy}
                      aria-label={t(
                        kind === "templates"
                          ? "curlDeleteTemplate"
                          : "curlDelete",
                      )}
                      title={t(
                        kind === "templates"
                          ? "curlDeleteTemplate"
                          : "curlDelete",
                      )}
                      onClick={() => void remove(entry, kind)}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </aside>
      </div>
    </div>
  );
}
