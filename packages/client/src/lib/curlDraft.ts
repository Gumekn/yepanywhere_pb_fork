import type {
  CurlCollection,
  CurlExecutionResult,
  CurlResponse,
} from "@yep-anywhere/shared";
import type { CurlExecution } from "../api/curl";

/** Lives only in NavigationLayout memory; leaving for login clears it. */
export interface CurlPageDraft {
  command: string;
  name: string;
  selectedId?: string;
  selectedCollection?: CurlCollection;
  baseline: { command: string; name: string };
  response?: CurlResponse;
  pending?: {
    id: string;
    result: Promise<CurlExecutionResult>;
    execution: CurlExecution;
  };
}

/** Sending records a run without changing the template being edited. */
export function completeCurlDraft(
  draft: CurlPageDraft,
  result: CurlExecutionResult,
): CurlPageDraft {
  const fromTemplate = draft.selectedCollection === "templates";
  return {
    ...draft,
    name: result.entry.name,
    selectedId: fromTemplate ? draft.selectedId : result.entry.id,
    selectedCollection: fromTemplate ? "templates" : "history",
    baseline: fromTemplate
      ? draft.baseline
      : { command: result.entry.command, name: result.entry.name },
    response: result.response,
    pending: undefined,
  };
}
