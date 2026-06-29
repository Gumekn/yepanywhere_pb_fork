import { describe, expect, it } from "vitest";
import {
  CODEX_DOLLAR_COMMANDS,
  STATIC_SLASH_COMMANDS,
  getAgentCommandConfig,
  getStaticAgentCommandConfigs,
} from "../agentCommands";

describe("agent command config", () => {
  it("uses dollar commands for Codex providers", () => {
    const config = getAgentCommandConfig("codex", false, ["ignored"]);

    expect(config.prefix).toBe("$");
    expect(config.label).toBe("Codex commands");
    expect(config.showButton).toBe(true);
    expect(config.commands).toBe(CODEX_DOLLAR_COMMANDS);
  });

  it("defaults Claude providers to slash command support", () => {
    const config = getAgentCommandConfig("claude", undefined, [
      "deep-research",
    ]);

    expect(config.prefix).toBe("/");
    expect(config.label).toBe("Slash commands");
    expect(config.showButton).toBe(true);
    expect(config.commands).toEqual([
      ...STATIC_SLASH_COMMANDS,
      "deep-research",
    ]);
  });

  it("hides commands for providers without command support", () => {
    const config = getAgentCommandConfig("gemini", false, ["ignored"]);

    expect(config.prefix).toBe("/");
    expect(config.showButton).toBe(false);
    expect(config.commands).toEqual([]);
  });

  it("builds static dollar and slash toolbar configs", () => {
    const configs = getStaticAgentCommandConfigs(["deep-research"]);

    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({
      prefix: "$",
      label: "Codex commands",
      showButton: true,
    });
    expect(configs[0]?.commands).toBe(CODEX_DOLLAR_COMMANDS);
    expect(configs[1]).toMatchObject({
      prefix: "/",
      label: "Slash commands",
      showButton: true,
    });
    expect(configs[1]?.commands).toEqual([
      ...STATIC_SLASH_COMMANDS,
      "deep-research",
    ]);
  });
});
