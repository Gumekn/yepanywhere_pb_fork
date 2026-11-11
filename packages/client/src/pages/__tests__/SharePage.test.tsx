import { cleanup, render, screen } from "@testing-library/react";
import type { PublicSessionShareResponse } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { matchShareRoute } from "../../lib/sessionShareLinks";
import { UI_KEYS } from "../../lib/storageKeys";
import { SharePage } from "../SharePage";

const TOKEN = "abcdefghijklmnopqrstuvwx";

const SHARE: PublicSessionShareResponse = {
  share: {
    createdAt: "2026-11-10T00:00:00.000Z",
    expiresAt: "2026-11-17T00:00:00.000Z",
  },
  snapshot: {
    version: 1,
    capturedAt: "2026-11-10T00:00:00.000Z",
    session: {
      title: "Capability map",
      provider: "dsh",
      projectName: "amap",
    },
    messages: [
      {
        uuid: "u1",
        type: "user",
        message: { role: "user", content: "Analyze the project" },
        timestamp: "2026-11-10T00:00:00.000Z",
      },
      {
        uuid: "a1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the capability map." }],
        },
        timestamp: "2026-11-10T00:00:01.000Z",
      },
    ],
    truncated: true,
  },
};

function renderPage() {
  return render(
    <I18nProvider>
      <SharePage token={TOKEN} />
    </I18nProvider>,
  );
}

describe("matchShareRoute", () => {
  it("extracts a token under the app base path", () => {
    expect(matchShareRoute(`/yep/share/${TOKEN}`, "/yep")).toBe(TOKEN);
    expect(matchShareRoute(`/share/${TOKEN}/`, undefined)).toBe(TOKEN);
  });

  it("ignores other routes and malformed tokens", () => {
    expect(matchShareRoute("/yep/projects", "/yep")).toBeNull();
    expect(matchShareRoute(`/share/${TOKEN}`, "/yep")).toBeNull();
    expect(matchShareRoute("/share/short", undefined)).toBeNull();
    expect(matchShareRoute("/share/..%2F..%2Fetc", undefined)).toBeNull();
  });
});

describe("SharePage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    vi.stubGlobal("fetch", fetchMock);
    // jsdom lacks the layout observers MessageList relies on.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(UI_KEYS.locale);
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("renders the frozen transcript read-only, without credentials", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(SHARE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderPage();

    expect(await screen.findByText("Capability map")).toBeTruthy();
    expect(screen.getByText("Read-only snapshot")).toBeTruthy();
    expect(screen.getByText("amap")).toBeTruthy();
    expect(await screen.findByText("Analyze the project")).toBeTruthy();
    expect(
      screen.getByText(/Older history could not be captured/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "View as Markdown" })
        .getAttribute("href"),
    ).toBe(
      `${window.location.origin}/api/public/session-shares/${TOKEN}/transcript.md`,
    );
    // No composer or edit affordances on a share.
    expect(document.querySelector("textarea")).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/public/session-shares/${TOKEN}`);
    expect(init).toMatchObject({ credentials: "omit" });
  });

  it("explains an expired or revoked link", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    renderPage();
    expect(
      await screen.findByText("This share link is unavailable"),
    ).toBeTruthy();
  });
});
