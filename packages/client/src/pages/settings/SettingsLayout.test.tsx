import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SettingsLayout } from "./SettingsLayout";

vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({ openSidebar: vi.fn(), isWideScreen: false }),
}));
vi.mock("../../components/PageHeader", () => ({ PageHeader: () => null }));

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("settings navigation after feature retirement", () => {
  afterEach(cleanup);

  it.each(["model", "agent-context", "emulator"])(
    "returns old %s links to a usable settings overview",
    async (category) => {
      localStorage.clear();
      localStorage.setItem("yep-anywhere-locale", "en");
      render(
        <MemoryRouter initialEntries={[`/settings/${category}`]}>
          <I18nProvider>
            <Location />
            <Routes>
              <Route path="/settings/:category?" element={<SettingsLayout />} />
            </Routes>
          </I18nProvider>
        </MemoryRouter>,
      );
      expect((await screen.findByTestId("location")).textContent).toBe(
        "/settings",
      );
      expect(
        screen.getByRole("button", { name: /Notifications/ }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: /Devices/ })).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Agent Context|Device Bridge/ }),
      ).toBeNull();
    },
  );
});
