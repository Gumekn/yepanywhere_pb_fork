import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CursorAccountResponse, CursorUsage } from "@yep-anywhere/shared";
import { findCursorAgentPath } from "./cursor-cli.js";
import type { AuthStatus } from "./types.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const USAGE_URL = "https://cursor.com/api/usage-summary";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function date(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

export function parseCursorUsage(value: unknown): {
  plan?: string;
  usage: CursorUsage | null;
} {
  const root = record(value);
  const individual = record(root.individualUsage);
  const plan = record(individual.plan);
  const onDemand = record(individual.onDemand);
  const total = number(plan.totalPercentUsed);
  const cursor = number(plan.autoPercentUsed);
  const api = number(plan.apiPercentUsed);
  const unlimited = root.isUnlimited === true;
  const hasUsage =
    unlimited ||
    total !== undefined ||
    cursor !== undefined ||
    api !== undefined ||
    (onDemand.enabled === true && number(onDemand.used) !== undefined);
  return {
    plan:
      typeof root.membershipType === "string" ? root.membershipType : undefined,
    usage: hasUsage
      ? {
          billingCycleStart: date(root.billingCycleStart),
          billingCycleEnd: date(root.billingCycleEnd),
          unlimited,
          totalPercentUsed: total,
          cursorPercentUsed: cursor,
          apiPercentUsed: api,
          ...(typeof onDemand.enabled === "boolean"
            ? {
                onDemand: {
                  enabled: onDemand.enabled,
                  usedUsd:
                    number(onDemand.used) === undefined
                      ? undefined
                      : (onDemand.used as number) / 100,
                  limitUsd:
                    number(onDemand.limit) === undefined
                      ? undefined
                      : (onDemand.limit as number) / 100,
                },
              }
            : {}),
        }
      : null,
  };
}

/** The dashboard cookie uses the JWT subject's user ID, not the numeric CLI userId. */
export function cursorSessionCookie(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const sub =
      typeof payload.sub === "string" ? payload.sub.split("|").at(-1) : null;
    if (!sub || !/^user_[a-zA-Z0-9]+$/.test(sub) || !/^[\w.-]+$/.test(token))
      return null;
    return `WorkosCursorSessionToken=${encodeURIComponent(`${sub}::${token}`)}`;
  } catch {
    return null;
  }
}

async function readAccessToken(): Promise<string | null> {
  if (process.env.CURSOR_AUTH_TOKEN?.trim())
    return process.env.CURSOR_AUTH_TOKEN.trim();
  if (process.env.CURSOR_API_KEY?.trim()) return null;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "cursor-access-token",
          "-a",
          "cursor-user",
          "-w",
        ],
        { encoding: "utf8", timeout: 8_000, maxBuffer: 64 * 1024 },
      );
      return stdout.trim() || null;
    } catch {
      // execFile errors can contain credentials in stdout. Never log them.
      return null;
    }
  }
  try {
    const configHome =
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const auth = record(
      JSON.parse(
        await readFile(join(configHome, "cursor", "auth.json"), "utf8"),
      ),
    );
    return typeof auth.accessToken === "string" ? auth.accessToken : null;
  } catch {
    return null;
  }
}

async function readCachedIdentity(): Promise<unknown> {
  const configDir =
    process.env.CURSOR_CONFIG_DIR?.trim() ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "cursor")
      : join(homedir(), ".cursor"));
  try {
    return record(
      JSON.parse(await readFile(join(configDir, "cli-config.json"), "utf8")),
    ).authInfo;
  } catch {
    return null;
  }
}

interface CursorAuthStatus extends AuthStatus {
  /** A failed status probe is not evidence that the user signed out. */
  checkUnavailable?: boolean;
}

export interface CursorAccountDependencies {
  findAgent: typeof findCursorAgentPath;
  run: (path: string, args: string[]) => Promise<string>;
  readToken: () => Promise<string | null>;
  readCachedIdentity?: () => Promise<unknown>;
  fetch: typeof globalThis.fetch;
  now: () => number;
}

export class CursorAccountService {
  private authCache?: { at: number; value: CursorAuthStatus };
  private authRequest?: Promise<CursorAuthStatus>;
  private cache?: { at: number; value: CursorAccountResponse };
  private request?: Promise<CursorAccountResponse>;

  constructor(
    private readonly deps: CursorAccountDependencies = {
      findAgent: findCursorAgentPath,
      run: async (path, args) =>
        (
          await execFileAsync(path, args, {
            encoding: "utf8",
            timeout: 8_000,
            maxBuffer: 64 * 1024,
          })
        ).stdout,
      readToken: readAccessToken,
      readCachedIdentity,
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
    },
  ) {}

  async getAuthStatus(fresh = false): Promise<CursorAuthStatus> {
    if (
      !fresh &&
      this.authCache &&
      this.deps.now() - this.authCache.at < CACHE_MS
    )
      return this.authCache.value;
    if (this.authRequest) return this.authRequest;
    this.authRequest = this.readAuth()
      .then((value) => {
        this.authCache = { at: this.deps.now(), value };
        return value;
      })
      .finally(() => {
        this.authRequest = undefined;
      });
    return this.authRequest;
  }

  private async readAuth(): Promise<CursorAuthStatus> {
    const path = await this.deps.findAgent();
    if (!path)
      return { installed: false, authenticated: false, enabled: false };
    try {
      const status = record(
        JSON.parse(await this.deps.run(path, ["status", "--format", "json"])),
      );
      const user = record(status.userInfo);
      const authenticated = status.isAuthenticated === true;
      if (authenticated && typeof user.email !== "string") {
        const cached = await this.readMatchingCachedAuth();
        if (cached) return cached;
      }
      return {
        installed: true,
        authenticated,
        enabled: authenticated,
        ...(authenticated
          ? {
              user: {
                email: typeof user.email === "string" ? user.email : undefined,
                name:
                  [user.firstName, user.lastName]
                    .filter((s) => typeof s === "string" && s)
                    .join(" ") || undefined,
              },
            }
          : {}),
      };
    } catch {
      return (
        (await this.readMatchingCachedAuth()) ?? {
          installed: true,
          authenticated: false,
          enabled: false,
          checkUnavailable: true,
        }
      );
    }
  }

  private async readMatchingCachedAuth(): Promise<CursorAuthStatus | null> {
    try {
      const [token, identityValue] = await Promise.all([
        this.deps.readToken(),
        this.deps.readCachedIdentity?.(),
      ]);
      if (!token || !cursorSessionCookie(token)) return null;
      const claims = record(
        JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ),
      );
      const identity = record(identityValue);
      // The CLI's numeric userId is unrelated to the token subject. Only use
      // cached display data belonging to this unexpired login, never another
      // account's old cli-config.json after a login switch.
      if (
        identity.authId !== claims.sub ||
        typeof identity.email !== "string" ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= this.deps.now()
      )
        return null;
      return {
        installed: true,
        authenticated: true,
        enabled: true,
        user: {
          email: identity.email,
          name:
            typeof identity.displayName === "string"
              ? identity.displayName
              : undefined,
        },
      };
    } catch {
      return null;
    }
  }

  async getAccount(
    options: { fresh?: boolean } = {},
  ): Promise<CursorAccountResponse> {
    if (
      !options.fresh &&
      this.cache &&
      this.deps.now() - this.cache.at < CACHE_MS
    )
      return this.cache.value;
    if (this.request) return this.request;
    this.request = this.loadAccount()
      .then((value) => {
        this.cache = { at: this.deps.now(), value };
        return value;
      })
      .finally(() => {
        this.request = undefined;
      });
    return this.request;
  }

  private async loadAccount(): Promise<CursorAccountResponse> {
    const auth = await this.getAuthStatus(true);
    const base: CursorAccountResponse = {
      installed: auth.installed,
      authenticated: auth.authenticated,
      user: auth.user,
      usage: null,
    };
    if (!auth.installed) return { ...base, error: "not-installed" };
    if (auth.checkUnavailable) return { ...base, error: "status-unavailable" };
    if (!auth.authenticated) return { ...base, error: "not-authenticated" };
    const fail = (
      error: CursorAccountResponse["error"],
    ): CursorAccountResponse => {
      const previous = this.cache?.value;
      const sameAccount =
        auth.user?.email && previous?.user?.email === auth.user.email;
      return {
        ...base,
        error,
        ...(sameAccount && previous?.usage
          ? {
              usage: previous.usage,
              plan: previous.plan,
              fetchedAt: previous.fetchedAt,
              stale: true,
            }
          : {}),
      };
    };
    try {
      const token = await this.deps.readToken();
      const cookie = token ? cursorSessionCookie(token) : null;
      if (!cookie) return fail("credentials-unavailable");
      const response = await this.deps.fetch(USAGE_URL, {
        headers: { Cookie: cookie, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403)
        return fail("auth-expired");
      if (response.status === 429) return fail("rate-limited");
      if (!response.ok) return fail("request-failed");
      const parsed = parseCursorUsage(await response.json());
      if (!parsed.usage)
        return { ...fail("usage-unavailable"), plan: parsed.plan };
      return {
        ...base,
        ...parsed,
        fetchedAt: new Date(this.deps.now()).toISOString(),
      };
    } catch {
      return fail("request-failed");
    }
  }
}

export const cursorAccountService = new CursorAccountService();
