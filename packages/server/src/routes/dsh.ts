import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import WebSocket from "ws";
import { DshWebError, type DshWebService } from "../dsh/web-service.js";
import {
  type AuthMiddlewareOptions,
  createAuthMiddleware,
} from "../middleware/auth.js";
import {
  hostCheckMiddleware,
  requireCustomHeader,
} from "../middleware/security.js";
import type { UploadDeps } from "./upload.js";

export const DSH_WEB_PATH = "/apps/dsh";
const DESKTOP_COOKIE = "yep_dsh_desktop";
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

interface DshRoutesOptions {
  service: Pick<DshWebService, "launch" | "getConnection" | "stop">;
  auth: AuthMiddlewareOptions;
  basePath?: string;
  upgradeWebSocket?: UploadDeps["upgradeWebSocket"];
}

/** No arbitrary upstream URLs: all traffic goes to the managed loopback process. */
export function createDshRoutes(options: DshRoutesOptions): Hono {
  const routes = new Hono();
  const prefix = `${options.basePath ?? ""}${DSH_WEB_PATH}`;
  const authenticate = createAuthMiddleware(options.auth);

  routes.use(
    "/api/dsh/*",
    hostCheckMiddleware,
    requireCustomHeader,
    authenticate,
  );
  routes.post("/api/dsh/launch", async (c) => {
    try {
      await options.service.launch();
      // An iframe cannot attach the desktop header to its subresources. Mint a
      // scoped, signed equivalent only when that exact credential authenticated
      // the launch. Password users continue to require their normal Yep session.
      const desktop = options.auth.desktopAuthToken;
      const supplied = c.req.header("x-desktop-token");
      if (
        desktop &&
        supplied &&
        Buffer.byteLength(desktop) === Buffer.byteLength(supplied) &&
        timingSafeEqual(Buffer.from(desktop), Buffer.from(supplied))
      ) {
        await setSignedCookie(c, DESKTOP_COOKIE, "desktop", desktop, {
          path: `${prefix}/`,
          httpOnly: true,
          sameSite: "Strict",
          maxAge: 86400,
          secure:
            c.req.header("origin")?.startsWith("https://") ??
            new URL(c.req.url).protocol === "https:",
        });
      }
      c.header("Cache-Control", "no-store");
      return c.json({ url: `${prefix}/` });
    } catch (error) {
      return c.json(
        {
          error: error instanceof DshWebError ? error.code : "DSH_START_FAILED",
        },
        503,
      );
    }
  });

  routes.post("/api/dsh/stop", async (c) => {
    if ((await c.req.json().catch(() => null))?.confirm !== true) {
      return c.json(
        { error: "Stopping DSH requires explicit confirmation" },
        400,
      );
    }
    try {
      await options.service.stop();
      return c.json({ stopped: true });
    } catch (error) {
      return c.json(
        {
          error: error instanceof DshWebError ? error.code : "DSH_STOP_FAILED",
        },
        409,
      );
    }
  });

  routes.use(`${DSH_WEB_PATH}/*`, hostCheckMiddleware);
  routes.use(`${DSH_WEB_PATH}/*`, async (c, next) => {
    const origin = c.req.header("origin");
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const upgrading = c.req.header("upgrade")?.toLowerCase() === "websocket";
    // DSH's client does not send Yep's custom header. Validate browser origin
    // before translating it to the private upstream origin instead.
    try {
      if (
        c.req.header("sec-fetch-site") === "cross-site" ||
        ((mutating || upgrading) && !origin) ||
        (origin &&
          new URL(origin).host !==
            (c.req.header("host") ?? new URL(c.req.url).host))
      ) {
        return c.json({ error: "Origin not allowed" }, 403);
      }
    } catch {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const desktop = options.auth.desktopAuthToken;
    if (
      desktop &&
      (await getSignedCookie(c, desktop, DESKTOP_COOKIE)) === "desktop"
    ) {
      c.req.raw.headers.set("x-desktop-token", desktop);
    }
    return authenticate(c, next);
  });

  routes.all(`${DSH_WEB_PATH}/*`, async (c) => {
    let upstream: Awaited<ReturnType<DshWebService["getConnection"]>>;
    try {
      upstream = await options.service.getConnection();
    } catch {
      return c.json({ error: "DSH_NOT_RUNNING" }, 503);
    }
    const incomingUrl = new URL(c.req.url);
    const path = incomingUrl.pathname.slice(prefix.length) || "/";
    // Concatenation deliberately avoids new URL(path, origin): a path beginning
    // with // must never select a different host.
    const target = `${upstream.origin}${path}${incomingUrl.search}`;
    const headers = new Headers(c.req.raw.headers);
    for (const name of [
      ...HOP_HEADERS,
      "authorization",
      "x-desktop-token",
      "x-yep-anywhere",
      "referer",
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "accept-encoding",
    ])
      headers.delete(name);
    headers.set("host", new URL(upstream.origin).host);
    headers.set("origin", upstream.origin);
    headers.set("cookie", upstream.cookie);

    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      if (!options.upgradeWebSocket)
        return c.json({ error: "WebSocket unavailable" }, 503);
      return options.upgradeWebSocket(() => {
        let remote: WebSocket | undefined;
        let client: WSContext | undefined;
        let pending: (string | ArrayBuffer)[] = [];
        let pendingBytes = 0;
        const close = () => {
          pending = [];
          remote?.terminate();
        };
        return {
          onOpen(_event: Event, ws: WSContext) {
            client = ws;
            remote = new WebSocket(target.replace(/^http:/, "ws:"), {
              headers: { cookie: upstream.cookie, origin: upstream.origin },
              handshakeTimeout: 10_000,
              maxPayload: 32 * 1024 * 1024,
            });
            remote.on("open", () => {
              for (const data of pending) remote?.send(data);
              pending = [];
              pendingBytes = 0;
            });
            remote.on("message", (data, binary) => {
              if (client?.readyState !== WebSocket.OPEN) return;
              const bytes = Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data as ArrayBuffer);
              client.send(binary ? new Uint8Array(bytes) : bytes.toString());
            });
            remote.on("close", (code) =>
              client?.close(code === 1000 ? 1000 : 1011),
            );
            remote.on("error", () =>
              client?.close(1011, "DSH connection failed"),
            );
          },
          onMessage(event: MessageEvent, ws: WSContext) {
            const data = event.data as string | ArrayBuffer;
            if (remote?.readyState === WebSocket.OPEN) {
              remote.send(data);
            } else {
              pendingBytes +=
                typeof data === "string"
                  ? Buffer.byteLength(data)
                  : data.byteLength;
              if (pendingBytes > 1024 * 1024) {
                ws.close(1009, "DSH connection not ready");
                close();
              } else pending.push(data);
            }
          },
          onClose: close,
          onError: close,
        };
      })(c);
    }

    try {
      const response = await fetch(target, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method)
          ? undefined
          : c.req.raw.body,
        // Node requires duplex for a streaming upload. Do not buffer attachments.
        ...{ duplex: "half" },
        redirect: "manual",
        signal: c.req.raw.signal,
      });
      const resultHeaders = new Headers(response.headers);
      for (const name of [
        ...HOP_HEADERS,
        "set-cookie",
        "content-encoding",
        "content-length",
      ])
        resultHeaders.delete(name);
      const location = resultHeaders.get("location");
      if (location?.startsWith("/") && !location.startsWith("//"))
        resultHeaders.set("location", `${prefix}${location}`);
      else if (location?.startsWith(`${upstream.origin}/`))
        resultHeaders.set(
          "location",
          `${prefix}${location.slice(upstream.origin.length)}`,
        );
      resultHeaders.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        headers: resultHeaders,
      });
    } catch {
      return c.json({ error: "DSH_UNAVAILABLE" }, 502);
    }
  });
  return routes;
}
