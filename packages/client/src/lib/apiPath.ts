/**
 * URL helpers that respect Vite's `base` so the same client bundle works
 * when served at root (`http://localhost:8022/`) or under a reverse-proxy
 * prefix (`https://air.yueyuan.uk/yep/`).
 *
 * Vite injects the build-time base into `import.meta.env.BASE_URL` (always
 * ends with a trailing slash). We strip the trailing slash so callers can
 * template `${API_BASE}/foo` without ending up with `//foo`.
 *
 * Note: this only affects the **direct-mode** browser fetch path. The WebSocket
 * protocol layer sends logical paths over the wire and the server adds the
 * prefix on the way back into the Hono router (see `ws-handlers.ts` basePath
 * handling) — those callers should keep sending plain `/api/...`.
 */
const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

/** Server URL prefix for direct HTTP fetches, e.g. "" or "/yep/api". */
export const API_BASE = `${BASE}/api`;

/** Build an absolute API path. `apiPath("/foo")` → `"/yep/api/foo"`. */
export function apiPath(path = ""): string {
  if (!path) return API_BASE;
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}
