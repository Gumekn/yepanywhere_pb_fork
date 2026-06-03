#!/usr/bin/env node

/**
 * Staging server for yepanywhere.com
 *
 * Serves the Astro dev server (site/) for the marketing site with HMR.
 *
 * Usage:
 *   pnpm staging              # Default port 3000
 *   PORT=8080 pnpm staging    # Custom port
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exitIfUnsafeHome } from "./safe-home.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

exitIfUnsafeHome({ entrypoint: "pnpm staging" });

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const astroPort = port + 10; // Internal Astro dev port (not exposed directly)

const sitePath = path.join(rootDir, "site");

// Content types for static files
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve a static file, always reading fresh from disk (no caching).
 */
function serveFile(res, filePath, fallbackPath = null) {
  const normalizedPath = path.normalize(filePath);

  fs.promises
    .stat(normalizedPath)
    .then((stat) => {
      if (stat.isFile()) {
        return fs.promises.readFile(normalizedPath);
      }
      throw new Error("Not a file");
    })
    .then((content) => {
      const ext = path.extname(normalizedPath).toLowerCase();
      const contentType = contentTypes[ext] || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(content);
    })
    .catch(() => {
      if (fallbackPath) {
        serveFile(res, fallbackPath);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });
}

/**
 * Proxy a request to the Astro dev server.
 */
function proxyToAstro(req, res) {
  const options = {
    hostname: "localhost",
    port: astroPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Astro dev server not ready yet");
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * Handle incoming requests.
 */
function handleRequest(req, res) {
  // All paths -> proxy to Astro dev server
  proxyToAstro(req, res);
}

// Track child processes for cleanup
const children = [];

function cleanup() {
  console.log("\nShutting down...");
  for (const child of children) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

/**
 * Start the Astro dev server for the marketing site.
 */
function startAstroDev() {
  console.log(`[Staging] Starting Astro dev server on port ${astroPort}...`);

  const astro = spawn("npx", ["astro", "dev", "--port", String(astroPort)], {
    cwd: sitePath,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  children.push(astro);

  astro.stdout.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Astro] ${msg}`);
  });

  astro.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[Astro] ${msg}`);
  });

  astro.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[Astro] Exited with code ${code}`);
    }
  });

  return astro;
}

/**
 * Start the proxy server.
 */
function startServer() {
  const server = http.createServer(handleRequest);

  server.listen(port, () => {
    console.log(`[Staging] Server running at http://localhost:${port}`);
    console.log(
      `[Staging]   /         -> Astro dev server (port ${astroPort})`,
    );
    console.log("[Staging] Site has HMR via Astro dev server");
  });

  return server;
}

// Main
async function main() {
  console.log("[Staging] Yepanywhere staging server");
  console.log("");

  // Check site folder exists
  if (!fs.existsSync(sitePath)) {
    console.error(`[Staging] Error: site/ folder not found at ${sitePath}`);
    process.exit(1);
  }

  // Start Astro dev server for marketing site
  startAstroDev();

  // Start proxy server
  startServer();
}

main().catch((err) => {
  console.error("[Staging] Error:", err.message);
  process.exit(1);
});
