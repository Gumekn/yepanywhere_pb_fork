/** Public model parameters reported by Cursor's ACP catalog. */
export interface CursorModelConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

/** Public Cursor account data. Never includes CLI credentials. */
export interface CursorAccountResponse {
  installed: boolean;
  authenticated: boolean;
  user?: { email?: string; name?: string };
  plan?: string;
  usage: CursorUsage | null;
  error?:
    | "not-installed"
    | "not-authenticated"
    | "status-unavailable"
    | "credentials-unavailable"
    | "auth-expired"
    | "rate-limited"
    | "usage-unavailable"
    | "request-failed";
  /** Timestamp of the last successful usage fetch, also retained on errors. */
  fetchedAt?: string;
  stale?: boolean;
}

export interface CursorUsage {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  unlimited: boolean;
  totalPercentUsed?: number;
  cursorPercentUsed?: number;
  apiPercentUsed?: number;
  onDemand?: { enabled: boolean; usedUsd?: number; limitUsd?: number };
}
