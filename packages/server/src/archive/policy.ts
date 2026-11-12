import { normalizeProviderGroup } from "../sessions/provider-groups.js";

/** These stores are shared with native apps; Yep only owns list visibility. */
export function usesMetadataOnlyArchive(provider: string | undefined): boolean {
  const group = normalizeProviderGroup(provider);
  return group === "codex" || group === "mcode" || group === "dsh";
}
