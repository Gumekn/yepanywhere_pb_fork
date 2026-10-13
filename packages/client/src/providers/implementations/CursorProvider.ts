import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for Cursor CLI via Agent Client Protocol.
 *
 * Cursor runs through `agent acp` on this machine. Session fork/branch is not
 * part of that ACP surface.
 */
export class CursorProvider implements Provider {
  readonly id = "cursor";
  readonly displayName = "Cursor";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Cursor CLI via Agent Client Protocol. Starts a local agent session and shows its transcript.",
    limitations: [
      "Requires the Cursor CLI (`agent`) and `agent login`",
      "Session fork/branch is not available over ACP",
      "Existing IDE chats are not listed; only ACP sessions are",
    ],
    website: "https://cursor.com/docs/cli/acp",
    cliName: "agent",
  };
}
