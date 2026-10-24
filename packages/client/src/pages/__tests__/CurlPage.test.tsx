import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type CurlExecutionResult,
  type CurlTemplate,
  parseCurlCommand,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { CurlPageDraft } from "../../lib/curlDraft";
import { UI_KEYS } from "../../lib/storageKeys";
import { CurlPage } from "../CurlPage";

const mocks = vi.hoisted(() => ({
  fetchJSON: vi.fn(),
  fetchResponse: vi.fn(),
  copy: vi.fn(),
  draft: { current: undefined as CurlPageDraft | undefined },
}));
vi.mock("../../api/client", () => ({
  fetchJSON: mocks.fetchJSON,
  fetchResponse: mocks.fetchResponse,
}));
vi.mock("../../lib/clipboard", () => ({ writeClipboardText: mocks.copy }));
vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: () => {},
}));
vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    curlDraft: mocks.draft,
  }),
}));

const command = `curl --noproxy 'api.example.test' 'https://api.example.test/v1/chat/completions' -H 'Authorization: Bearer test-key' -H 'Content-Type: application/json' -d '{"model":"example","messages":[]}'`;
const saved: CurlTemplate = {
  id: "e97a878f-15db-486c-8853-2d9067874473",
  name: "Chat request",
  command,
  updatedAt: "2026-10-20T01:00:00Z",
};
function renderPage() {
  return render(
    <I18nProvider>
      <CurlPage />
    </I18nProvider>,
  );
}
function pasteCommand(value = command) {
  fireEvent.change(screen.getByLabelText("cURL command"), {
    target: { value },
  });
}

describe("cURL editor", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(UI_KEYS.locale, "en");
    mocks.fetchJSON.mockReset();
    mocks.fetchResponse.mockReset();
    mocks.fetchResponse.mockImplementation(
      async (path, options) =>
        new Response(JSON.stringify(await mocks.fetchJSON(path, options)), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    mocks.draft.current = undefined;
    mocks.copy.mockReset();
    mocks.fetchJSON.mockResolvedValue({ entries: [], templates: [] });
    mocks.copy.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("imports a command and exports edited URL, key, multiline headers and JSON without losing noproxy", async () => {
    renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    pasteCommand();
    const key = screen.getByLabelText("Bearer API Key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("test-key");
    fireEvent.change(key, { target: { value: "edited-test-key" } });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://new.example.test/v1/chat/completions" },
    });
    fireEvent.change(screen.getByLabelText("Headers"), {
      target: { value: "Content-Type: application/json\nX-Lane: test\n" },
    });
    fireEvent.change(screen.getByLabelText("Request body"), {
      target: { value: '{"messages":[{"content":"你好"}]}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    const exported = parseCurlCommand(mocks.copy.mock.calls[0]?.[0]);
    expect(exported).toMatchObject({
      url: "https://new.example.test/v1/chat/completions",
      noProxy: "api.example.test",
      body: '{"messages":[{"content":"你好"}]}',
    });
    expect(exported.headers).toEqual([
      "Content-Type: application/json",
      "X-Lane: test",
      "Authorization: Bearer edited-test-key",
    ]);
    expect(
      (screen.getByLabelText("cURL command") as HTMLTextAreaElement).value,
    ).toContain("edited-test-key");
    pasteCommand("curl https://another.example.test -H 'X-New: value'");
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://another.example.test",
    );
    expect(key.value).toBe("");
    expect(
      (screen.getByLabelText("Request body") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(screen.queryByText("Copied.")).toBeNull();
  });

  it("shows editable details immediately and copies all connection settings with feedback", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Form" })).toBeNull();
    expect(
      screen.getByText("Connection options").closest("details")?.open,
    ).toBe(true);
    const copy = screen.getByRole("button", {
      name: "Copy full cURL",
    }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.test/v1?q[]=one" },
    });
    fireEvent.change(screen.getByLabelText("Proxy URL"), {
      target: { value: "http://localhost:7890" },
    });
    fireEvent.click(screen.getByLabelText("Follow redirects"));
    fireEvent.click(
      screen.getByLabelText("Skip TLS certificate verification (--insecure)"),
    );
    fireEvent.click(screen.getByLabelText("Accept compressed responses"));
    fireEvent.click(copy);
    await screen.findByText("Copied.");
    const exported = mocks.copy.mock.calls[0]?.[0];
    expect(parseCurlCommand(exported)).toMatchObject({
      url: "https://example.test/v1?q[]=one",
      proxy: "http://localhost:7890",
      followRedirects: true,
      insecure: true,
      compressed: true,
      timeoutSeconds: 120,
    });
    expect(exported).toContain("--max-time 120");
    expect(exported).toContain("--globoff --no-buffer");
    expect(
      mocks.fetchJSON.mock.calls.some(
        ([, options]) => options?.method === "POST",
      ),
    ).toBe(false);

    mocks.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    fireEvent.click(copy);
    await screen.findByText(
      "Copy failed. Select the text and copy it manually.",
    );
    expect(screen.queryByText("Copied.")).toBeNull();
    fireEvent.click(copy);
    await screen.findByText("Copied.");
    expect(
      screen.queryByText("Copy failed. Select the text and copy it manually."),
    ).toBeNull();
  });

  it("sets a custom timeout or removes the limit from the form", async () => {
    renderPage();
    pasteCommand();
    const timeout = screen.getByLabelText(
      /Timeout in seconds/,
    ) as HTMLInputElement;
    expect(timeout.value).toBe("120");
    fireEvent.change(timeout, { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    expect(parseCurlCommand(mocks.copy.mock.calls[0]?.[0]).timeoutSeconds).toBe(
      600,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "No timeout limit" }));
    expect(timeout.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(2));
    expect(
      parseCurlCommand(mocks.copy.mock.calls[1]?.[0]).timeoutSeconds,
    ).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "No timeout limit" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(3));
    expect(parseCurlCommand(mocks.copy.mock.calls[2]?.[0]).timeoutSeconds).toBe(
      600,
    );
  });

  it("opens a template, updates it, and saves a separate template", async () => {
    mocks.fetchJSON.mockImplementation(async (path, options) => {
      if (!options) return { entries: [], templates: [saved] };
      const body = JSON.parse(options.body);
      return {
        entry: {
          ...saved,
          ...body,
          id:
            path === "/curl/templates"
              ? "88ee7f53-c9f2-4921-8f07-67e882e81bed"
              : saved.id,
        },
      };
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Chat request/ }),
    );
    fireEvent.change(screen.getByLabelText("Request name"), {
      target: { value: "Edited request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update template" }));
    await screen.findByText("Template saved.");
    expect(mocks.fetchJSON).toHaveBeenCalledWith(
      `/curl/templates/${saved.id}`,
      expect.objectContaining({ method: "PUT" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save as new template" }),
    );
    await waitFor(() =>
      expect(mocks.fetchJSON).toHaveBeenCalledWith(
        "/curl/templates",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(
      mocks.fetchJSON.mock.calls.some(([path]) => path === "/curl/execute"),
    ).toBe(false);
  });

  it("shows no-proxy outside collapsed options and preserves an edited domain through save and reopen", async () => {
    let stored = { ...saved };
    mocks.fetchJSON.mockImplementation(async (_path, options) => {
      if (!options) return { entries: [], templates: [stored] };
      stored = { ...stored, ...JSON.parse(options.body) };
      return { entry: stored };
    });
    const first = renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Chat request/ }),
    );
    const field = screen.getByRole("textbox", {
      name: "Bypass proxy for (--noproxy)",
    }) as HTMLInputElement;
    expect(field.closest("details")).toBeNull();
    expect(field.value).toBe("api.example.test");
    fireEvent.change(field, {
      target: { value: "overseas.example.test,localhost" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update template" }));
    await screen.findByText("Template saved.");
    expect(parseCurlCommand(stored.command).noProxy).toBe(
      "overseas.example.test,localhost",
    );
    first.unmount();
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Chat request/ }),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Bypass proxy for (--noproxy)",
        }) as HTMLInputElement
      ).value,
    ).toBe("overseas.example.test,localhost");
  });

  it("preserves an explicitly empty no-proxy list and can restore server defaults", async () => {
    renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    pasteCommand();
    fireEvent.change(screen.getByLabelText("Bypass proxy for (--noproxy)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    expect(parseCurlCommand(mocks.copy.mock.calls[0]?.[0]).noProxy).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "Use server defaults" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(2));
    expect(parseCurlCommand(mocks.copy.mock.calls[1]?.[0]).noProxy).toBeNull();
  });

  it("uses the current URL hostname only on request, keeping custom bypass lists intact", async () => {
    renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    pasteCommand();
    const field = screen.getByLabelText(
      "Bypass proxy for (--noproxy)",
    ) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("URL"), {
      target: {
        value: "https://overseas.example.test:8443/v1/chat/completions",
      },
    });
    expect(field.value).toBe("api.example.test");
    fireEvent.click(
      screen.getByRole("button", { name: "Use current hostname" }),
    );
    expect(field.value).toBe("overseas.example.test");
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Use current hostname",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(field.value).toBe("overseas.example.test");
  });

  it("sends once, displays an HTTP error body and adds the request to history", async () => {
    mocks.fetchJSON.mockImplementation(async (path) =>
      path === "/curl/execute"
        ? {
            entry: {
              ...saved,
              run: { status: 401, durationMs: 42, error: null },
            },
            response: {
              status: 401,
              durationMs: 42,
              error: null,
              headers: "HTTP/1.1 401 Unauthorized",
              body: '{"error":"invalid test key"}',
              size: 28,
              truncated: false,
            },
            historySaved: true,
          }
        : { entries: [], templates: [] },
    );
    renderPage();
    pasteCommand();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText(/"error": "invalid test key"/);
    expect(screen.getAllByText("HTTP 401").length).toBeGreaterThan(0);
    expect(
      mocks.fetchJSON.mock.calls.filter(([path]) => path === "/curl/execute"),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Chat request/ })).toBeTruthy();
  });

  it("renders SSE before completion, keeps receiving across navigation, and preserves content after cancel", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    mocks.fetchResponse.mockResolvedValue(
      new Response(stream, {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
    const encode = (event: unknown) =>
      new TextEncoder().encode(`${JSON.stringify(event)}\n`);
    const first = renderPage();
    pasteCommand();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const firstEvent =
      'data: {"choices":[{"delta":{"content":"First token"}}]}\n\n';
    await act(async () => {
      controller.enqueue(
        encode({
          type: "headers",
          data: "Content-Type: text/event-stream\r\n",
          status: 200,
          durationMs: 1,
        }),
      );
      controller.enqueue(
        encode({
          type: "data",
          data: firstEvent,
          size: firstEvent.length,
          durationMs: 10,
        }),
      );
    });
    await screen.findByText("First token");
    expect(screen.getByRole("button", { name: "Cancel request" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Raw events" }));
    expect(screen.getByText(firstEvent.trim())).toBeTruthy();
    first.unmount();
    renderPage();
    await screen.findByText("First token");
    const secondEvent = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
    await act(async () => {
      controller.enqueue(
        encode({ type: "data", data: secondEvent, size: 100, durationMs: 20 }),
      );
    });
    await screen.findByText("First token你好");
    mocks.fetchJSON.mockResolvedValue({ cancelled: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(
        mocks.fetchJSON.mock.calls.some(([path]) =>
          path.startsWith("/curl/cancel/"),
        ),
      ).toBe(true),
    );
    await act(async () => {
      controller.enqueue(
        encode({
          type: "complete",
          result: {
            entry: {
              ...saved,
              run: { status: 200, durationMs: 30, error: "cancelled" },
            },
            historySaved: true,
            response: {
              status: 200,
              durationMs: 30,
              size: 100,
              body: firstEvent + secondEvent,
              headers: "Content-Type: text/event-stream",
              error: "cancelled",
              truncated: false,
            },
          },
        }),
      );
      controller.close();
    });
    await screen.findByText(
      "Request cancelled. The remote server may already have processed it.",
    );
    expect(screen.getByText("First token你好")).toBeTruthy();
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("enables AI streaming in the JSON body without changing other request fields", async () => {
    renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    pasteCommand();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "AI streaming response (stream: true)",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    const request = parseCurlCommand(mocks.copy.mock.calls[0]?.[0]);
    expect(JSON.parse(request.body ?? "")).toEqual({
      model: "example",
      messages: [],
      stream: true,
    });
    expect(request.noProxy).toBe("api.example.test");
  });

  it("rejects a shell pipeline and keeps invalid source editable", async () => {
    renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    pasteCommand(`${command} | jq .`);
    expect(
      (
        screen.getByRole("button", {
          name: "Send request",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByLabelText("cURL command")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Copy full cURL",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByLabelText("URL").matches(":disabled")).toBe(true);
    pasteCommand();
    expect(screen.getByLabelText("URL").matches(":disabled")).toBe(false);
    expect(
      (screen.getByLabelText("Bearer API Key") as HTMLInputElement).value,
    ).toBe("test-key");
    expect(
      mocks.fetchJSON.mock.calls.some(
        ([, options]) => options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("preserves edits across page navigation without browser storage", async () => {
    const first = renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    pasteCommand();
    fireEvent.change(screen.getByLabelText("Request name"), {
      target: { value: "Unsaved draft" },
    });
    fireEvent.change(screen.getByLabelText("Bearer API Key"), {
      target: { value: "edited-key" },
    });
    first.unmount();
    renderPage();
    await screen.findByText(
      "Sent requests appear here. Reopen one to reuse it or save it as a template.",
    );
    expect(
      (screen.getByLabelText("Request name") as HTMLInputElement).value,
    ).toBe("Unsaved draft");
    expect(
      (screen.getByLabelText("cURL command") as HTMLTextAreaElement).value,
    ).toContain("edited-key");
    expect(
      (screen.getByLabelText("Bearer API Key") as HTMLInputElement).value,
    ).toBe("edited-key");
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://api.example.test/v1/chat/completions",
    );
    expect(JSON.stringify(window.localStorage)).not.toContain("edited-key");
  });

  it("rejoins an active request after navigation and can cancel it without sending twice", async () => {
    let finish!: (value: CurlExecutionResult) => void;
    const pending = new Promise<CurlExecutionResult>((resolve) => {
      finish = resolve;
    });
    mocks.fetchJSON.mockImplementation(async (path) => {
      if (path === "/curl/execute") return pending;
      if (path.startsWith("/curl/cancel/")) return { cancelled: true };
      return { entries: [], templates: [] };
    });
    const first = renderPage();
    pasteCommand();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("button", { name: "Cancel request" });
    first.unmount();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(
        mocks.fetchJSON.mock.calls.some(([path]) =>
          path.startsWith("/curl/cancel/"),
        ),
      ).toBe(true),
    );
    await act(async () => {
      finish({
        entry: {
          ...saved,
          run: { status: 0, durationMs: 50, error: "cancelled" },
        },
        response: {
          status: 0,
          durationMs: 50,
          error: "cancelled",
          headers: "",
          body: "",
          size: 0,
          truncated: false,
        },
        historySaved: true,
      });
      await pending;
    });
    await screen.findByText(
      "Request cancelled. The remote server may already have processed it.",
    );
    expect(
      mocks.fetchJSON.mock.calls.filter(([path]) => path === "/curl/execute"),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
  });

  it.each([
    "authorization: Bearer second-key",
    "Authorization: Basic test-basic",
  ])(
    "preserves duplicate Authorization order with %s and keeps history clean",
    async (secondHeader) => {
      const duplicate = {
        ...saved,
        command: `${command} -H '${secondHeader}'`,
      };
      mocks.fetchJSON.mockResolvedValue({
        entries: [],
        templates: [duplicate],
      });
      renderPage();
      fireEvent.click(
        await screen.findByRole("button", { name: /Chat request/ }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy full cURL" }));
      await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
      expect(parseCurlCommand(mocks.copy.mock.calls[0]?.[0]).headers).toEqual(
        parseCurlCommand(duplicate.command).headers,
      );
      fireEvent.click(screen.getByRole("button", { name: "New request" }));
      expect(window.confirm).not.toHaveBeenCalled();
    },
  );

  it("restores the saved baseline after editing an existing request and navigating away", async () => {
    mocks.fetchJSON.mockImplementation(async (_path, options) => {
      if (!options) return { entries: [], templates: [saved] };
      return { entry: { ...saved, ...JSON.parse(options.body) } };
    });
    const first = renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Chat request/ }),
    );
    fireEvent.change(screen.getByLabelText("Bearer API Key"), {
      target: { value: "saved-updated-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update template" }));
    await screen.findByText("Template saved.");
    first.unmount();
    renderPage();
    await screen.findByRole("button", { name: /Chat request/ });
    expect(
      (screen.getByLabelText("cURL command") as HTMLTextAreaElement).value,
    ).toContain("saved-updated-key");
    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("keeps edits when discarding is declined and provides a retry for history failures", async () => {
    mocks.fetchJSON.mockRejectedValueOnce(new Error("curlError_storage"));
    renderPage();
    await screen.findByRole("button", { name: "Retry" });
    mocks.fetchJSON.mockResolvedValue({ entries: [], templates: [saved] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const history = await screen.findByRole("button", { name: /Chat request/ });
    pasteCommand();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(history);
    expect(screen.getByLabelText("cURL command")).toBeTruthy();
    expect(
      (screen.getByLabelText("Request name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("sends template edits into history, updates the template only explicitly, and saves history as a new template", async () => {
    const historyId = "88ee7f53-c9f2-4921-8f07-67e882e81bed";
    mocks.fetchJSON.mockImplementation(async (path, options) => {
      if (!options) return { templates: [saved], entries: [] };
      const body = JSON.parse(options.body);
      if (path === "/curl/execute")
        return {
          entry: {
            ...saved,
            ...body,
            id: historyId,
            run: { status: 200, durationMs: 1, error: null },
          },
          response: {
            status: 200,
            durationMs: 1,
            error: null,
            headers: "",
            body: "Executed",
            size: 8,
            truncated: false,
          },
          historySaved: true,
        };
      return { entry: { ...saved, ...body } };
    });
    renderPage();
    const templates = within(
      screen.getByRole("region", { name: "Request templates" }),
    );
    const history = within(
      screen.getByRole("region", { name: "Request history" }),
    );
    fireEvent.click(
      await templates.findByRole("button", { name: /Chat request/ }),
    );
    fireEvent.change(screen.getByLabelText("Bearer API Key"), {
      target: { value: "run-only-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Executed");
    expect(
      templates.getAllByRole("button", { name: /Chat request/ }),
    ).toHaveLength(1);
    expect(
      history.getAllByRole("button", { name: /Chat request/ }),
    ).toHaveLength(1);
    expect(mocks.draft.current?.baseline.command).toBe(saved.command);
    expect(mocks.draft.current?.selectedId).toBe(saved.id);
    expect(
      mocks.fetchJSON.mock.calls.filter(
        ([, options]) => options?.method === "POST",
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Update template" }));
    await screen.findByText("Template saved.");
    expect(mocks.fetchJSON).toHaveBeenCalledWith(
      `/curl/templates/${saved.id}`,
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("run-only-key"),
      }),
    );
    fireEvent.click(history.getByRole("button", { name: /Chat request/ }));
    expect(
      screen.queryByRole("button", { name: "Update template" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save as template" }));
    await waitFor(() =>
      expect(mocks.fetchJSON).toHaveBeenCalledWith(
        "/curl/templates",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(history.getByRole("button", { name: /Chat request/ })).toBeTruthy();
  });

  it("keeps the template baseline when an edited template finishes during page navigation", async () => {
    let finish!: (result: CurlExecutionResult) => void;
    const pending = new Promise<CurlExecutionResult>((resolve) => {
      finish = resolve;
    });
    mocks.fetchJSON.mockImplementation(async (path) =>
      path === "/curl/execute" ? pending : { templates: [saved], entries: [] },
    );
    const first = renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Chat request/ }),
    );
    fireEvent.change(screen.getByLabelText("Bearer API Key"), {
      target: { value: "navigation-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("button", { name: "Cancel request" });
    const edited = (
      screen.getByLabelText("cURL command") as HTMLTextAreaElement
    ).value;
    first.unmount();
    renderPage();
    await act(async () => {
      finish({
        entry: {
          ...saved,
          id: "88ee7f53-c9f2-4921-8f07-67e882e81bed",
          command: edited,
          run: { status: 200, durationMs: 1, error: null },
        },
        response: {
          status: 200,
          durationMs: 1,
          error: null,
          headers: "",
          body: "Finished",
          size: 8,
          truncated: false,
        },
        historySaved: true,
      });
      await pending;
    });
    await screen.findByText("Finished");
    expect(mocks.draft.current?.selectedCollection).toBe("templates");
    expect(mocks.draft.current?.selectedId).toBe(saved.id);
    expect(mocks.draft.current?.baseline.command).toBe(saved.command);
    expect(
      screen.getByRole("button", { name: "Update template" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    expect(window.confirm).toHaveBeenCalledOnce();
  });

  it("deletes history and templates through separate actions without changing the other list", async () => {
    const historyId = "88ee7f53-c9f2-4921-8f07-67e882e81bed";
    mocks.fetchJSON.mockImplementation(async (_path, options) =>
      options
        ? { deleted: true }
        : {
            templates: [saved],
            entries: [
              {
                ...saved,
                id: historyId,
                run: { status: 200, durationMs: 1, error: null },
              },
            ],
          },
    );
    renderPage();
    const templates = within(
      screen.getByRole("region", { name: "Request templates" }),
    );
    const history = within(
      screen.getByRole("region", { name: "Request history" }),
    );
    fireEvent.click(
      await history.findByRole("button", { name: "Delete history entry" }),
    );
    await waitFor(() =>
      expect(
        history.queryByRole("button", { name: /Chat request/ }),
      ).toBeNull(),
    );
    expect(
      templates.getByRole("button", { name: /Chat request/ }),
    ).toBeTruthy();
    expect(mocks.fetchJSON).toHaveBeenCalledWith(`/curl/history/${historyId}`, {
      method: "DELETE",
    });
    fireEvent.click(templates.getByRole("button", { name: "Delete template" }));
    await waitFor(() =>
      expect(
        templates.queryByRole("button", { name: /Chat request/ }),
      ).toBeNull(),
    );
    expect(mocks.fetchJSON).toHaveBeenCalledWith(
      `/curl/templates/${saved.id}`,
      { method: "DELETE" },
    );
  });
});
