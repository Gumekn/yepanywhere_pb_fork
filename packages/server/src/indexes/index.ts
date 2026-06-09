export {
  SessionIndexService,
  type CachedSessionSummary,
  type SessionIndexServiceOptions,
  type SessionIndexState,
} from "./SessionIndexService.js";

export {
  SessionContentIndexService,
  type CachedSessionContent,
  type LoadSessionMessages,
  type ScopeSearchResult,
  type SessionContentIndexServiceOptions,
  type SessionContentIndexState,
} from "./SessionContentIndexService.js";

export type {
  IndexedMessage,
  TextMatch,
} from "./extractSearchableText.js";

export type { ISessionIndexService } from "./types.js";
