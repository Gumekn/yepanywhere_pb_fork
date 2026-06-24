import type { CodexMcpMode } from "@yep-anywhere/shared";

export const CODEX_STANDARD_MCP_APP_SERVER_ARGS = [
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "-c",
  "mcp_servers.chrome-devtools.enabled=false",
] as const;

export function getCodexMcpAppServerArgs(
  mode: CodexMcpMode | undefined,
): string[] {
  return mode === "full" ? [] : [...CODEX_STANDARD_MCP_APP_SERVER_ARGS];
}
