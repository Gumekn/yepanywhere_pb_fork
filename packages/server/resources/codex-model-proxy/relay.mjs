import http from "node:http";
import https from "node:https";
import httpProxy from "http-proxy";
import { HttpsProxyAgent } from "https-proxy-agent";

const MODEL_PATHS = new Set([
  "/responses",
  "/responses/compact",
  "/memories/trace_summarize",
]);

export function directEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (
      /^(https?|all)_proxy$/i.test(key) ||
      key === "YEP_CODEX_MODEL_PROXY_URL"
    ) {
      delete result[key];
    }
  }
  // Also suppress client-library/system proxy discovery in child tools.
  result.NO_PROXY = result.no_proxy = "*";
  return result;
}

export function isModelRequest(method, path, upgrade = false) {
  return upgrade
    ? method === "GET" && path === "/responses"
    : method === "POST" && MODEL_PATHS.has(path);
}

export function selectOpenAiBase(config, account) {
  const configured = config.openai_base_url;
  const base = new URL(
    configured ||
      (account?.type === "chatgpt"
        ? "https://chatgpt.com/backend-api/codex"
        : "https://api.openai.com/v1"),
  );
  // A user's custom gateway must remain their gateway, never be silently
  // replaced or sent through a proxy intended only for first-party OpenAI.
  if (
    base.protocol !== "https:" ||
    !["chatgpt.com", "api.openai.com", "chat.openai.com"].includes(
      base.hostname,
    ) ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    return null;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix !== "/v1" && prefix !== "/backend-api/codex") return null;
  return base;
}

/** A model endpoint relay, not a general HTTP/CONNECT forward proxy. */
export async function startModelRelay({ upstreamBase, proxyUrl, ca }) {
  const base = new URL(upstreamBase);
  const proxyAddress = new URL(proxyUrl);
  if (!["http:", "https:"].includes(proxyAddress.protocol)) {
    throw new Error("The model proxy must use HTTP or HTTPS CONNECT");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const headers = {};
  if (proxyAddress.username || proxyAddress.password) {
    headers["Proxy-Authorization"] =
      `Basic ${Buffer.from(`${decodeURIComponent(proxyAddress.username)}:${decodeURIComponent(proxyAddress.password)}`).toString("base64")}`;
    proxyAddress.username = proxyAddress.password = "";
  }
  // The dependency's debug logging may print the proxy URL. Keep credentials
  // in its CONNECT headers instead of that URL.
  const remoteAgent = new HttpsProxyAgent(proxyAddress, {
    keepAlive: true,
    headers,
    ...(ca ? { ca } : {}),
  });
  const directAgent =
    base.protocol === "https:"
      ? new https.Agent({ keepAlive: true })
      : new http.Agent({ keepAlive: true });
  const forwarder = httpProxy.createProxyServer({
    target: base.origin,
    changeOrigin: true,
    xfwd: false,
    followRedirects: false,
    ...(ca ? { ca } : {}),
  });
  forwarder.on("proxyReq", (outgoing, _req, res) => {
    if (res.destroyed) outgoing.destroy();
    else
      res.once("close", () => {
        if (!res.writableFinished) outgoing.destroy();
      });
  });
  forwarder.on("proxyRes", (incoming, req, res) => {
    if (
      route(req, false)?.agent === remoteAgent &&
      incoming.statusCode >= 300 &&
      incoming.statusCode < 400
    ) {
      res
        .writeHead(502, { "content-type": "text/plain" })
        .end("OpenAI model redirects are not allowed");
      incoming.resume();
      return;
    }
    incoming.on("error", () => res.destroy());
    res.once("close", () => {
      if (!incoming.complete) incoming.destroy();
    });
  });
  forwarder.on("proxyReqWs", (outgoing, req, socket) => {
    socket.once("close", () => outgoing.destroy());
    outgoing.on("response", (incoming) => {
      if (
        route(req, true)?.agent === remoteAgent &&
        incoming.statusCode >= 300 &&
        incoming.statusCode < 400
      ) {
        socket.destroy();
        incoming.destroy();
      }
    });
  });
  const sockets = new Set();

  function route(req, upgrade) {
    // Accept only origin-form paths under the original provider base.
    // Parse neither request bodies nor model data: SSE, zstd and WS stay intact.
    if (!req.url?.startsWith(`${prefix}/`) || /[\\\r\n]/.test(req.url))
      return null;
    const path = req.url.split("?", 1)[0];
    if (path !== new URL(req.url, base.origin).pathname) return null;
    const model = isModelRequest(
      req.method,
      path.slice(prefix.length),
      upgrade,
    );
    // Header keys must actually be absent; undefined fails Node's validation.
    // biome-ignore lint/performance/noDelete: Remove credentials before forwarding.
    delete req.headers["proxy-authorization"];
    // biome-ignore lint/performance/noDelete: Remove proxy-only connection metadata.
    delete req.headers["proxy-connection"];
    return { agent: model ? remoteAgent : directAgent };
  }

  const server = http.createServer((req, res) => {
    const options = route(req, false);
    if (!options) {
      res.writeHead(404).end();
      return;
    }
    forwarder.web(req, res, options, () => {
      // No fallback to direct on model failure; never expose proxy URLs/keys.
      if (res.headersSent) res.destroy();
      else
        res
          .writeHead(502, { "content-type": "text/plain" })
          .end("OpenAI relay connection failed");
    });
  });
  server.requestTimeout = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (_req, socket) =>
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"),
  );
  server.on("upgrade", (req, socket, head) => {
    const options = route(req, true);
    if (!options) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    forwarder.ws(req, socket, head, options, () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}${prefix}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      remoteAgent.destroy();
      directAgent.destroy();
      forwarder.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
