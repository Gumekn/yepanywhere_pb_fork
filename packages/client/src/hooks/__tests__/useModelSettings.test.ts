import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCurrentInstallId, setServerScoped } from "../../lib/storageKeys";
import {
  getModelSetting,
  getThinkingSetting,
  getVoiceInputEnabled,
  useModelSettings,
} from "../useModelSettings";

describe("input preferences after retiring model settings", () => {
  beforeEach(() => {
    localStorage.clear();
    setCurrentInstallId("input-preferences");
  });
  afterEach(cleanup);

  it("preserves a saved model across input changes and remounts", () => {
    setServerScoped("model", "opus[1m]");
    setServerScoped("thinkingMode", "on");
    setServerScoped("thinkingLevel", "thorough");
    setServerScoped("voiceInputEnabled", "false");
    const { result, unmount } = renderHook(() => useModelSettings());
    expect(getModelSetting()).toBe("opus");
    expect(getThinkingSetting()).toBe("on:max");
    expect(result.current.voiceInputEnabled).toBe(false);

    act(() => {
      result.current.setEffortLevel("medium");
      result.current.toggleVoiceInput();
    });
    expect(getThinkingSetting()).toBe("on:medium");
    expect(getVoiceInputEnabled()).toBe(true);
    expect(getModelSetting()).toBe("opus");
    unmount();

    const reloaded = renderHook(() => useModelSettings());
    expect(reloaded.result.current.thinkingLevel).toBe("medium");
    expect(reloaded.result.current.voiceInputEnabled).toBe(true);
    act(() => reloaded.result.current.cycleThinkingMode());
    expect(getThinkingSetting()).toBe("off");
  });

  it("does not carry legacy preferences into another server", () => {
    setServerScoped("model", "haiku");
    setServerScoped("voiceInputEnabled", "false");
    setCurrentInstallId("another-server");
    expect(getModelSetting()).toBe("default");
    expect(getThinkingSetting()).toBe("off");
    expect(getVoiceInputEnabled()).toBe(true);
  });
});
