import { afterEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../../shared/test/fixtures/cursor-model-catalog.json";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import {
  loadCursorModelCatalog,
  parseCursorModelCatalog,
} from "../../../src/sdk/providers/cursor-models.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Cursor native model catalog", () => {
  it("exposes base models with the real context, reasoning and speed choices", () => {
    const models = parseCursorModelCatalog(catalog);
    expect(models.map((model) => model.id)).toEqual([
      "auto",
      "grok-4.7",
      "composer-2.5",
      "claude-opus-5",
      "gpt-5.6-sol",
    ]);
    expect(models[0]?.cursorConfigOptions).toEqual([]);
    expect(models.at(-1)?.cursorConfigOptions).toMatchObject([
      {
        id: "context",
        currentValue: "272k",
        options: [
          { value: "272k", name: "272K" },
          { value: "1m", name: "1M" },
        ],
      },
      { id: "reasoning", currentValue: "medium" },
      { id: "fast", currentValue: "false" },
    ]);
    expect(models[1]?.cursorConfigOptions?.at(-1)?.options.at(-1)?.name).toBe(
      "Fast",
    );
  });

  it("does not invent choices from malformed parameter data", () => {
    const invalid = {
      value: "bad",
      name: "Bad model",
      configOptions: [
        {
          id: "context",
          name: "Context",
          currentValue: "unknown",
          options: [{ value: "1m", name: "1M" }],
        },
      ],
    };
    expect(
      parseCursorModelCatalog({ models: [catalog.models[0], invalid] }),
    ).toHaveLength(1);
    expect(() => parseCursorModelCatalog({ models: [invalid] })).toThrow(
      "Empty Cursor model catalog",
    );
  });

  it("discovers models without authenticating interactively or creating a session", async () => {
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
    });
    const request = vi
      .spyOn(ACPClient.prototype, "requestExtension")
      .mockResolvedValue(catalog);
    const close = vi
      .spyOn(ACPClient.prototype, "close")
      .mockImplementation(() => {});
    const auth = vi.spyOn(ACPClient.prototype, "authenticate");
    const session = vi.spyOn(ACPClient.prototype, "newSession");
    expect(await loadCursorModelCatalog("/agent")).toHaveLength(5);
    expect(request).toHaveBeenCalledWith("cursor/list_available_models");
    expect(auth).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes only its discovery client when the catalog times out", async () => {
    vi.useFakeTimers();
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockReturnValue(
      new Promise(() => {}),
    );
    const close = vi
      .spyOn(ACPClient.prototype, "close")
      .mockImplementation(() => {});
    const result = expect(loadCursorModelCatalog("/agent")).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(close).toHaveBeenCalledOnce();
  });
});
