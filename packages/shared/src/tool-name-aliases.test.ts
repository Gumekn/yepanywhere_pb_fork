import { describe, expect, it } from "vitest";
import {
  SHARED_RENDERER_TOOL_ALIASES,
  lookupToolAlias,
} from "./tool-name-aliases.js";

describe("shared renderer tool aliases", () => {
  it("contains only the aliases Codex and the client registry already share", () => {
    expect(SHARED_RENDERER_TOOL_ALIASES).toEqual({
      shell_command: "Bash",
      exec_command: "Bash",
      write_stdin: "WriteStdin",
      update_plan: "UpdatePlan",
      apply_patch: "Edit",
      web_search_call: "WebSearch",
      search_query: "WebSearch",
    });
    expect(SHARED_RENDERER_TOOL_ALIASES).not.toHaveProperty("exec");
    expect(SHARED_RENDERER_TOOL_ALIASES).not.toHaveProperty("bash");
    expect(SHARED_RENDERER_TOOL_ALIASES).not.toHaveProperty("ls");
  });

  it("matches an exact key, then a lowercase key, and otherwise keeps the name", () => {
    const aliases = {
      ...SHARED_RENDERER_TOOL_ALIASES,
      exec: "CodexExec",
      bash: "Bash",
    };
    expect(lookupToolAlias(aliases, "shell_command")).toBe("Bash");
    expect(lookupToolAlias(aliases, "Apply_Patch")).toBe("Edit");
    expect(lookupToolAlias(aliases, "exec")).toBe("CodexExec");
    expect(lookupToolAlias(aliases, "ls")).toBe("ls");
    expect(lookupToolAlias(SHARED_RENDERER_TOOL_ALIASES, "bash")).toBe("bash");
  });
});
