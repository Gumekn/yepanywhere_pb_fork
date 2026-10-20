/**
 * Renderer aliases already shared by Codex normalization and the client tool
 * registry. Exact key, then lowercase key, otherwise the original name.
 *
 * Do not add Pi names here. Pi maps `ls` and `find` to `Glob`, and leaves
 * `shell_command` unchanged. Do not add Codex `exec` here either: only the
 * Codex normalizer turns that into `CodexExec`.
 */
export const SHARED_RENDERER_TOOL_ALIASES: Record<string, string> = {
  shell_command: "Bash",
  exec_command: "Bash",
  write_stdin: "WriteStdin",
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
};

export function lookupToolAlias(
  aliases: Record<string, string>,
  name: string,
): string {
  return aliases[name] ?? aliases[name.toLowerCase()] ?? name;
}
