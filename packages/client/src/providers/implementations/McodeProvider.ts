import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for MiniMax Code via Agent Client Protocol.
 *
 * MiniMax Code (`mcode acp`) shares `~/.minimax` with the MiniMax Code desktop
 * App, so sessions started in the App are listed here and can be continued.
 */
export class McodeProvider implements Provider {
  readonly id = "mcode";
  readonly displayName = "MiniMax Code";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "MiniMax Code CLI via Agent Client Protocol. Lists sessions from the CLI and the MiniMax Code App and can continue them.",
    limitations: [
      "Requires the MiniMax Code CLI (`mcode`) and `mcode login`",
      "Editing or rewinding earlier messages is not available over ACP",
      "Sessions in the App's default workspace are hidden unless MCODE_INCLUDE_DEFAULT_WORKSPACE=1",
    ],
    website: "https://agent.minimax.io/docs/cli/quick-start",
    cliName: "mcode",
  };
}
