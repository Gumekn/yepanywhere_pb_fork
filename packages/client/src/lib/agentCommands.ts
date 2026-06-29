import type { ProviderName } from "@yep-anywhere/shared";

export type AgentCommandPrefix = "/" | "$";

export const CODEX_DOLLAR_COMMANDS = [
  "permissions",
  "ide",
  "keymap",
  "vim",
  "sandbox-add-read-dir",
  "agent",
  "apps",
  "plugins",
  "hooks",
  "clear",
  "archive",
  "delete",
  "compact",
  "copy",
  "diff",
  "exit",
  "experimental",
  "approve",
  "memories",
  "skills",
  "import",
  "feedback",
  "init",
  "logout",
  "mcp",
  "mention",
  "model",
  "fast",
  "plan",
  "goal",
  "personality",
  "ps",
  "stop",
  "fork",
  "side",
  "btw",
  "raw",
  "resume",
  "new",
  "quit",
  "review",
  "status",
  "usage",
  "debug-config",
  "statusline",
  "title",
  "theme",
];

export const STATIC_SLASH_COMMANDS = [
  "help",
  "status",
  "model",
  "permissions",
  "clear",
  "compact",
  "resume",
  "init",
  "memory",
  "mcp",
  "agents",
  "add-dir",
  "config",
  "cost",
  "doctor",
  "ide",
  "login",
  "logout",
  "review",
  "vim",
];

export interface AgentCommandConfig {
  prefix: AgentCommandPrefix;
  label: string;
  showButton: boolean;
  commands: string[];
}

export function isCodexCommandProvider(
  provider: ProviderName | string | undefined | null,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

export function providerDefaultsToSlashCommands(
  provider: ProviderName | string | undefined | null,
): boolean {
  return provider === "claude" || provider === "claude-ollama";
}

function mergeCommands(...commandGroups: string[][]): string[] {
  return Array.from(new Set(commandGroups.flat().filter(Boolean)));
}

export function getStaticAgentCommandConfigs(
  slashCommands: string[] = [],
): AgentCommandConfig[] {
  return [
    {
      prefix: "$",
      label: "Codex commands",
      showButton: true,
      commands: CODEX_DOLLAR_COMMANDS,
    },
    {
      prefix: "/",
      label: "Slash commands",
      showButton: true,
      commands: mergeCommands(STATIC_SLASH_COMMANDS, slashCommands),
    },
  ];
}

export function getAgentCommandConfig(
  provider: ProviderName | string | undefined | null,
  supportsSlashCommands?: boolean,
  slashCommands: string[] = [],
): AgentCommandConfig {
  if (isCodexCommandProvider(provider)) {
    return {
      prefix: "$",
      label: "Codex commands",
      showButton: true,
      commands: CODEX_DOLLAR_COMMANDS,
    };
  }

  const canUseSlashCommands =
    supportsSlashCommands ?? providerDefaultsToSlashCommands(provider);

  return {
    prefix: "/",
    label: "Slash commands",
    showButton: canUseSlashCommands,
    commands: canUseSlashCommands
      ? mergeCommands(STATIC_SLASH_COMMANDS, slashCommands)
      : [],
  };
}
