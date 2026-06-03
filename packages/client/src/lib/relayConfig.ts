/**
 * Relay endpoint defaults and persistence for the remote client (relay APK / web).
 *
 * Why: the hosted relay endpoint changes (DNS, frp nodes, providers); hard-coding
 * a single host in the UI means every move requires a rebuild. We default to a
 * known-working endpoint, but let users override it from the login screen and
 * remember their last choice across sessions.
 */

import { loadSavedHosts, removeHost, saveHost } from "./hostStorage";
import { REMOTE_CREDENTIALS_KEY } from "./storageKeys";

export const DEFAULT_RELAY_URL = "ws://39.106.200.1:28101/ws";

const STORAGE_KEY = "yep:lastRelayUrl";

/**
 * Hostnames in saved storage that are known dead and must be rewritten on
 * boot. Keeps existing users from being locked out by stale storage when
 * a frp provider rotates DNS — the alternative is asking every user to
 * find the in-app endpoint switcher or reinstall.
 */
const DEAD_HOST_MIGRATIONS: Record<string, string> = {
  "gd03.frp0.cc": "39.106.200.1",
  "hk03.frp0.cc": "39.106.200.1",
  "air.yueyuan.net.cn": "air.yueyuan.uk",
};

function rewriteDeadHost(url: string | undefined): string | undefined {
  if (!url) return url;
  for (const [dead, alive] of Object.entries(DEAD_HOST_MIGRATIONS)) {
    if (url.includes(dead)) return url.split(dead).join(alive);
  }
  return url;
}

/**
 * yepanywhere server now mounts under BASE_PATH=/yep, so historic direct
 * URLs (ws://host:port/api/ws) need /yep injected before /api/ws or the
 * Hono router 404s the upgrade. We only rewrite when the path is the bare
 * `/api/ws` legacy form — anything richer (custom path, already-prefixed
 * /yep/api/ws, /someotherprefix/api/ws) is left alone so users who set a
 * non-default deploy can still connect.
 */
function injectBasePathInDirectUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/ws") {
      parsed.pathname = "/yep/api/ws";
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL — leave it for the user to fix via the
    // endpoint switcher rather than guessing.
  }
  return url;
}

function migrateDirectUrl(url: string | undefined): string | undefined {
  return injectBasePathInDirectUrl(rewriteDeadHost(url));
}

/**
 * Boot-time storage cleanup:
 *   1. Rewrite dead hostnames inside surviving direct hosts.
 *   2. Drop every saved relay-mode host + the relay session cache.
 *
 * We're decommissioning the relay path in favor of self-hosted frp tcp
 * tunnels (Direct mode). Existing users have stale relay entries pinned
 * to dead frp endpoints; without this they'd boot into a 5s reconnect
 * stall every time. Idempotent — safe to run on every cold start.
 */
export function migrateDeadRelayHosts(): boolean {
  let changed = false;
  try {
    const { hosts } = loadSavedHosts();
    for (const host of hosts) {
      if (host.mode === "relay") {
        // Relay path is retired; nuke the saved entry so auto-resume
        // never selects it.
        removeHost(host.id);
        changed = true;
        continue;
      }
      const nextRelay = rewriteDeadHost(host.relayUrl);
      const nextWs = migrateDirectUrl(host.wsUrl);
      if (nextRelay !== host.relayUrl || nextWs !== host.wsUrl) {
        saveHost({ ...host, relayUrl: nextRelay, wsUrl: nextWs });
        changed = true;
      }
    }
  } catch {
    // Best effort. If storage is locked we'll just retry next boot.
  }
  try {
    // The legacy single-credential cache also pins the active mode/url
    // and is read by RemoteConnectionContext.storedRef on boot to drive
    // auto-resume. Drop it whenever the saved mode is relay, otherwise
    // rewrite the dead host as before.
    const raw = localStorage.getItem(REMOTE_CREDENTIALS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { mode?: string; wsUrl?: string };
        if (parsed.mode === "relay") {
          localStorage.removeItem(REMOTE_CREDENTIALS_KEY);
          changed = true;
        } else {
          const nextWs = migrateDirectUrl(parsed.wsUrl);
          if (nextWs && nextWs !== parsed.wsUrl) {
            localStorage.setItem(
              REMOTE_CREDENTIALS_KEY,
              JSON.stringify({ ...parsed, wsUrl: nextWs }),
            );
            changed = true;
          }
        }
      } catch {
        // Malformed JSON — wipe so we don't keep failing to boot.
        localStorage.removeItem(REMOTE_CREDENTIALS_KEY);
        changed = true;
      }
    }
  } catch {
    // ignore
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const rewritten = rewriteDeadHost(stored ?? undefined);
    if (stored && rewritten !== stored) {
      localStorage.setItem(STORAGE_KEY, rewritten ?? "");
      changed = true;
    }
  } catch {
    // ignore
  }
  return changed;
}

export function getStoredRelayUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setStoredRelayUrl(url: string): void {
  try {
    const trimmed = url.trim();
    if (!trimmed || trimmed === DEFAULT_RELAY_URL) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, trimmed);
    }
  } catch {
    // localStorage unavailable (private mode, quota) — silently ignore
  }
}
