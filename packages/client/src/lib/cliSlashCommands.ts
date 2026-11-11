/**
 * The `/` lists the provider CLIs show in their own terminal pickers, so the
 * Yep composer offers exactly what a user would see in `codex` or `pi`.
 *
 * Only some of them can run through Yep (see `YEP_HANDLED_*`); the rest are
 * terminal UI features that app-server/RPC cannot execute. Those stay in the
 * list for parity but are marked terminal-only and are never sent to the
 * model as text.
 */

export interface CliSlashCommand {
  name: string;
  /** The CLI's own picker description. */
  description: string;
  /** Other names the CLI accepts for the same command. */
  aliases?: readonly string[];
  /**
   * How the CLI picker treats it beyond the default: `typed` entries (Codex
   * aliases such as `/quit`, `/btw`) appear only once a prefix is typed;
   * `hidden` ones (`/apps`) never appear but still run when typed.
   */
  picker?: "typed" | "hidden";
}

/**
 * Codex TUI built-ins in picker order, as `codex-cli` 0.167 shows them on
 * macOS with ChatGPT sign-in (`references/codex/codex-rs/tui/src/
 * slash_command.rs` and `bottom_pane/command_popup.rs`, checked against the
 * real picker). Omitted like the TUI does: Windows-only
 * `/setup-default-sandbox`, debug-build `/rollout` and `/test-approval`, and
 * the `debug-*` commands.
 */
export const CODEX_CLI_SLASH_COMMANDS: readonly CliSlashCommand[] = [
  {
    name: "model",
    description: "choose what model and reasoning effort to use",
  },
  {
    name: "presets",
    description: "run or save reusable prompts and slash commands",
  },
  {
    name: "daybreak",
    description: "Learn about broader access for cybersecurity work",
  },
  {
    name: "ide",
    description:
      "include current selection, open files, and other context from your IDE",
  },
  { name: "permissions", description: "choose what Codex is allowed to do" },
  { name: "keymap", description: "remap TUI shortcuts" },
  { name: "vim", description: "toggle Vim mode for the composer" },
  { name: "experimental", description: "toggle experimental features" },
  {
    name: "approve",
    description: "approve one retry of a recent auto-review denial",
  },
  { name: "memories", description: "configure memory use and generation" },
  {
    name: "skills",
    description: "use skills to improve how Codex performs specific tasks",
  },
  {
    name: "import",
    description:
      "import setup, this project, and recent chats from Claude Code",
  },
  { name: "hooks", description: "view and manage lifecycle hooks" },
  { name: "review", description: "review my current changes and find issues" },
  { name: "rename", description: "rename the current thread" },
  { name: "new", description: "start a new chat during a conversation" },
  { name: "archive", description: "archive this session" },
  { name: "delete", description: "permanently delete this session" },
  { name: "resume", description: "resume a saved chat" },
  { name: "fork", description: "fork the current chat" },
  {
    name: "worktree",
    description: "start or continue a conversation in a new worktree",
  },
  { name: "app", description: "continue this session in the Desktop app" },
  {
    name: "init",
    description: "create an AGENTS.md file with instructions for Codex",
  },
  {
    name: "compact",
    description: "summarize conversation to prevent hitting the context limit",
  },
  { name: "config", description: "configure Codex preferences" },
  { name: "recap", description: "summarize the current conversation now" },
  { name: "plan", description: "switch to Plan mode" },
  {
    name: "voice",
    description: "start or stop voice; use /voice settings to choose a voice",
  },
  { name: "goal", description: "set or view the goal for a long-running task" },
  { name: "agents", description: "open the agent command center" },
  {
    name: "side",
    description: "start a side conversation in an ephemeral fork",
  },
  {
    name: "btw",
    description: "start a side conversation in an ephemeral fork",
    picker: "typed",
  },
  { name: "copy", description: "copy the last response or part of it" },
  { name: "export", description: "export the conversation as markdown" },
  {
    name: "raw",
    description:
      "toggle raw scrollback mode for copy-friendly terminal selection",
  },
  { name: "tui", description: "choose the TUI mode for the next launch" },
  { name: "diff", description: "show git diff (including untracked files)" },
  { name: "mention", description: "mention a file" },
  {
    name: "status",
    description: "show current session configuration and token usage",
  },
  { name: "daemon", description: "Manage the local background server" },
  {
    name: "warnings",
    description: "view retained warnings and diagnostic details",
  },
  { name: "cd", description: "change the current working directory" },
  {
    name: "pwd",
    description: "show the current working directory",
    aliases: ["cwd"],
  },
  {
    name: "usage",
    description: "view account usage or use a usage limit reset",
  },
  {
    name: "title",
    description: "configure which items appear in the terminal title",
  },
  {
    name: "statusline",
    description: "configure which items appear in the status line",
  },
  { name: "theme", description: "choose a syntax highlighting theme" },
  {
    name: "pets",
    description: "choose or hide the terminal pet",
    aliases: ["pet"],
  },
  {
    name: "mcp",
    description: "list MCP tools; use /mcp verbose or /mcp login <name>",
  },
  { name: "apps", description: "manage apps", picker: "hidden" },
  { name: "plugins", description: "browse plugins" },
  { name: "logout", description: "log out of Codex" },
  { name: "quit", description: "exit Codex", picker: "typed" },
  { name: "exit", description: "exit Codex" },
  { name: "feedback", description: "send logs to maintainers" },
  { name: "ps", description: "list background terminals" },
  {
    name: "stop",
    description: "stop all background terminals",
    aliases: ["clean"],
  },
  { name: "clear", description: "clear the terminal and start a new chat" },
  { name: "subagents", description: "switch between this session's subagents" },
];

/**
 * The Codex TUI lists the current model's service tiers right after
 * `/model`, named after the tier (`priority` is called "Fast", so `/fast`).
 * Every current OpenAI model has it; Yep reports it as `supportsFastMode`.
 */
export const CODEX_FAST_SLASH_COMMAND: CliSlashCommand = {
  name: "fast",
  description: "toggle the Fast service tier (faster, increased usage)",
};

/**
 * Pi interactive built-ins in picker order (`@earendil-works/pi-coding-agent`
 * 1.5.0, `core/slash-commands.ts`). Pi lists prompt templates, extension
 * commands and skills after these; Yep takes those from Pi's `get_commands`.
 */
export const PI_CLI_SLASH_COMMANDS: readonly CliSlashCommand[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Set thinking level" },
  {
    name: "scoped-models",
    description: "Enable/disable models for Ctrl+P cycling",
  },
  {
    name: "export",
    description: "Export session (HTML default, or specify path: .html/.jsonl)",
  },
  {
    name: "import",
    description:
      "Import a JSONL session, preserving its ID and working directory",
  },
  {
    name: "share",
    description: "Share session via a Radius artifact or a GitHub gist",
  },
  { name: "bug", description: "Report a bug to the Pi developers" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  {
    name: "fork",
    description: "Create a new fork from a previous user message",
  },
  {
    name: "clone",
    description: "Duplicate the current session at the current position",
  },
  {
    name: "trust",
    description: "Save project trust decision for future sessions",
  },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume another session" },
  {
    name: "reload",
    description:
      "Reload keybindings, extensions, skills, prompts, themes, and context files",
  },
  { name: "quit", description: "Quit pi" },
];

/** CLI commands Yep executes itself (mapped to a native control or Yep UI). */
export const YEP_HANDLED_CODEX_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "model",
  "review",
  "goal",
  "side",
  "btw",
]);

export const YEP_HANDLED_PI_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "model",
]);

/**
 * Yep features offered next to Pi's own list: Pi has no side conversation,
 * Yep provides one (same names as the Codex CLI).
 */
export const YEP_EXTRA_PI_COMMANDS = ["side", "btw"] as const;

export type CliSlashProvider = "codex" | "pi";

function cliCommands(provider: CliSlashProvider) {
  return provider === "codex"
    ? CODEX_CLI_SLASH_COMMANDS
    : PI_CLI_SLASH_COMMANDS;
}

function yepHandled(provider: CliSlashProvider) {
  return provider === "codex"
    ? YEP_HANDLED_CODEX_COMMANDS
    : YEP_HANDLED_PI_COMMANDS;
}

/** The leading `/name` of a message, or null. */
export function leadingSlashCommandName(text: string): string | null {
  const match = /^\/([^\s/]+)(?:\s|$)/u.exec(text.trimStart());
  return match?.[1] ?? null;
}

/**
 * The CLI built-in a message invokes when Yep cannot run it (terminal UI
 * only), resolving CLI aliases. Provider-reported commands of the same name
 * (Pi extensions, prompts, skills) win, because Pi runs those over RPC.
 */
export function terminalOnlyCommand(
  provider: CliSlashProvider,
  text: string,
  providerCommandNames: Iterable<string> = [],
): string | null {
  const name = leadingSlashCommandName(text);
  if (!name) return null;
  if (new Set(providerCommandNames).has(name)) return null;
  const command = [
    ...cliCommands(provider),
    ...(provider === "codex" ? [CODEX_FAST_SLASH_COMMAND] : []),
  ].find((entry) => entry.name === name || entry.aliases?.includes(name));
  if (!command || yepHandled(provider).has(command.name)) return null;
  return command.name;
}
