import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SessionShareRecord } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { ShareSessionDialog } from "../ShareSessionDialog";

vi.mock("../../api/client", () => ({
  api: {
    createSessionShareLink: vi.fn(),
    listSessionShareLinks: vi.fn(),
    revokeSessionShareLink: vi.fn(),
  },
}));

const TOKEN = "abcdefghijklmnopqrstuvwx";

function record(overrides: Partial<SessionShareRecord> = {}) {
  return {
    token: TOKEN,
    projectId: "project",
    sessionId: "session-1",
    title: "Capability map",
    createdAt: "2026-11-10T00:00:00.000Z",
    expiresAt: "2026-11-17T00:00:00.000Z",
    messageCount: 4,
    sizeBytes: 100,
    ...overrides,
  } satisfies SessionShareRecord;
}

function renderDialog() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <ShareSessionDialog
          projectId="project"
          sessionId="session-1"
          title="Capability map"
          onClose={vi.fn()}
        />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("ShareSessionDialog", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(UI_KEYS.locale);
    vi.clearAllMocks();
  });

  it("creates a link with the chosen expiry and copies it", async () => {
    vi.mocked(api.listSessionShareLinks).mockResolvedValue({ shares: [] });
    vi.mocked(api.createSessionShareLink).mockResolvedValue({
      share: record({ expiresAt: null }),
    });
    renderDialog();

    expect(
      await screen.findByText("No active links for this session."),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Never"));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(api.createSessionShareLink).toHaveBeenCalledWith({
        projectId: "project",
        sessionId: "session-1",
        expiresIn: "never",
        title: "Capability map",
      }),
    );
    const expectedUrl = `${window.location.origin}/share/${TOKEN}`;
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedUrl));
    expect(screen.getByDisplayValue(expectedUrl)).toBeTruthy();
    expect(screen.getByText("never expires")).toBeTruthy();
  });

  it("revokes an existing link", async () => {
    vi.mocked(api.listSessionShareLinks).mockResolvedValue({
      shares: [record()],
    });
    vi.mocked(api.revokeSessionShareLink).mockResolvedValue({ ok: true });
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(api.revokeSessionShareLink).toHaveBeenCalledWith(TOKEN),
    );
    expect(
      await screen.findByText("No active links for this session."),
    ).toBeTruthy();
  });
});
