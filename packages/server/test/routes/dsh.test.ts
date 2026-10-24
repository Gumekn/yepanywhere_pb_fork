import { once } from "node:events";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AuthService } from "../../src/auth/AuthService.js";
import { DshWebError } from "../../src/dsh/web-service.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/proxy.js";
import { createDshRoutes } from "../../src/routes/dsh.js";

describe("DSH Web access", () => {
  let upstream: Server;
  let upstreamSockets: WebSocketServer;
  let server: ReturnType<typeof serve> | undefined;
  let origin: string;
  const launch = vi.fn();
  const getConnection = vi.fn();
  const stop = vi.fn(async () => {});
  const validateSession = vi.fn(async () => false);
  let enabled = false;
  let requests = 0;
  const authService = {
    isEnabled: () => enabled,
    isLocalhostOpen: () => false,
    hasAccount: () => true,
    validateSession,
  } as unknown as AuthService;

  beforeEach(async () => {
    enabled = false;
    requests = 0;
    vi.clearAllMocks();
    upstream = createServer(async (req, res) => {
      requests++;
      if (req.url === "/redirect") {
        res.writeHead(302, {
          location: "/next",
          "set-cookie": "private=never-forward",
        });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          path: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    upstreamSockets = new WebSocketServer({ server: upstream });
    upstreamSockets.on("connection", (socket) =>
      socket.on("message", (data, isBinary) =>
        socket.send(data, { binary: isBinary }),
      ),
    );
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    launch.mockResolvedValue({ origin, cookie: "dsh_session=private" });
    getConnection.mockResolvedValue({ origin, cookie: "dsh_session=private" });
  });

  afterEach(async () => {
    for (const socket of upstreamSockets.clients) socket.terminate();
    upstreamSockets.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function app(desktopAuthToken?: string) {
    const root = new Hono();
    const application = root.basePath("/yep");
    const websocket = createNodeWebSocket({ app: application });
    application.route(
      "/",
      createDshRoutes({
        service: { launch, getConnection, stop },
        basePath: "/yep",
        auth: { authService, desktopAuthToken },
        upgradeWebSocket: websocket.upgradeWebSocket,
      }),
    );
    return { application, websocket };
  }

  function request(application: Hono, path: string, init?: RequestInit) {
    return application.request(
      `http://localhost/yep${path}`,
      {
        ...init,
        headers: { host: "localhost", ...init?.headers },
      },
      {},
    );
  }

  it("launches only with Yep authentication and the mutation header; returns no DSH credential", async () => {
    const { application } = app();
    expect(
      (await request(application, "/api/dsh/launch", { method: "POST" }))
        .status,
    ).toBe(403);
    enabled = true;
    expect(
      (
        await request(application, "/api/dsh/launch", {
          method: "POST",
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).status,
    ).toBe(401);
    expect(launch).not.toHaveBeenCalled();
    enabled = false;
    const response = await request(application, "/api/dsh/launch", {
      method: "POST",
      headers: { "X-Yep-Anywhere": "true" },
    });
    expect(await response.json()).toEqual({ url: "/yep/apps/dsh/" });
  });

  it("enforces authentication on HTML, assets, and API requests", async () => {
    enabled = true;
    const { application } = app();
    for (const path of ["/", "/assets/index.js", "/api/remote.mux"]) {
      expect((await request(application, `/apps/dsh${path}`)).status).toBe(401);
    }
    expect(getConnection).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it("requires an authenticated, explicitly confirmed stop", async () => {
    const { application } = app();
    const options = {
      method: "POST",
      headers: { "X-Yep-Anywhere": "true", "Content-Type": "application/json" },
    };
    expect((await request(application, "/api/dsh/stop", options)).status).toBe(
      400,
    );
    expect(stop).not.toHaveBeenCalled();
    enabled = true;
    expect(
      (
        await request(application, "/api/dsh/stop", {
          ...options,
          body: '{"confirm":true}',
        })
      ).status,
    ).toBe(401);
    expect(stop).not.toHaveBeenCalled();
    enabled = false;
    expect(
      (
        await request(application, "/api/dsh/stop", {
          ...options,
          body: '{"confirm":true}',
        })
      ).status,
    ).toBe(200);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("proxies subpaths and queries without forwarding Yep secrets", async () => {
    const { application } = app();
    const response = await request(application, "/apps/dsh/api/items?a=1", {
      headers: {
        cookie: "yep_session=secret",
        authorization: "Bearer yep-secret",
        "x-desktop-token": "secret",
      },
    });
    const data = await response.json();
    expect(data.path).toBe("/api/items?a=1");
    expect(data.headers.cookie).toBe("dsh_session=private");
    expect(data.headers.authorization).toBeUndefined();
    expect(data.headers["x-desktop-token"]).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects foreign or missing mutation origins, but streams same-origin request bodies", async () => {
    const { application } = app();
    for (const origin of [undefined, "https://evil.example", "null"]) {
      const response = await request(application, "/apps/dsh/api/write", {
        method: "POST",
        headers: origin ? { origin } : {},
        body: "secret",
      });
      expect(response.status).toBe(403);
    }
    expect(requests).toBe(0);
    const response = await request(application, "/apps/dsh/api/write", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: "payload",
    });
    expect((await response.json()).body).toBe("payload");
  });

  it("rewrites root redirects and does not leak upstream cookies", async () => {
    const { application } = app();
    const response = await request(application, "/apps/dsh/redirect");
    expect(response.headers.get("location")).toBe("/yep/apps/dsh/next");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("issues a scoped desktop cookie only for a valid desktop token", async () => {
    const { application } = app("desktop-secret");
    const response = await request(application, "/api/dsh/launch", {
      method: "POST",
      headers: {
        "X-Yep-Anywhere": "true",
        "x-desktop-token": "desktop-secret",
      },
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Path=/yep/apps/dsh/");
    expect(cookie).not.toContain("desktop-secret");
    expect((await request(application, "/apps/dsh/")).status).toBe(401);
    const frame = await request(application, "/apps/dsh/", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(frame.status).toBe(200);
    expect((await frame.json()).headers["x-desktop-token"]).toBeUndefined();
  });

  it("returns a safe installation error", async () => {
    launch.mockRejectedValueOnce(new DshWebError("DSH_NOT_INSTALLED"));
    const { application } = app();
    const response = await request(application, "/api/dsh/launch", {
      method: "POST",
      headers: { "X-Yep-Anywhere": "true" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DSH_NOT_INSTALLED" });
  });

  it("forwards text and binary WebSocket frames through the prefixed Yep endpoint", async () => {
    const { application, websocket } = app();
    server = serve({
      fetch: application.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!server.listening) await once(server, "listening");
    attachUnifiedUpgradeHandler(server, {
      app: application,
      wss: websocket.wss,
      isApiPath: (path) => path.startsWith("/yep/apps/dsh/"),
    });
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const socket = new WebSocket(`ws://${host}/yep/apps/dsh/api/remote.mux`, {
      origin: `http://${host}`,
    });
    try {
      await once(socket, "open");
      const text = once(socket, "message");
      socket.send("hello");
      const [data, binary] = await text;
      expect(data.toString()).toBe("hello");
      expect(binary).toBe(false);
      const bytes = once(socket, "message");
      socket.send(Buffer.from([0, 1, 255]));
      const [result, isBinary] = await bytes;
      expect([...result]).toEqual([0, 1, 255]);
      expect(isBinary).toBe(true);
    } finally {
      socket.terminate();
    }
  });
});
