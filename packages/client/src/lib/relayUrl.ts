/**
 * Parse a user-typed endpoint into a canonical relay WebSocket URL.
 *
 * Why: when the APK is stuck mid-reconnect because the saved relay URL
 * died (DNS rotated, frp node moved), the user needs a place to paste
 * whatever they have on hand — a browser-style URL, an IP+port, or a
 * full ws://. Accept all of those and produce one canonical form.
 *
 * Rules:
 *   - http://x         → ws://x/ws
 *   - https://x        → wss://x/ws
 *   - ws://x[/p]       → ws://x[/p]      (preserve explicit path)
 *   - wss://x[/p]      → wss://x[/p]
 *   - host[:port][/p]  → ws://host[:port]/ws   (no scheme → assume ws)
 *
 * If the input parses to a URL with a path, we keep that path verbatim
 * so cpolar / nginx prefixes survive ("https://x/api" → "wss://x/api").
 * Only when the path is empty or "/" do we substitute "/ws".
 */
export function normalizeRelayUrl(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Endpoint is empty");
  }

  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : `ws://${raw}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid endpoint: ${input}`);
  }

  const scheme = url.protocol.toLowerCase();
  let wsScheme: "ws:" | "wss:";
  switch (scheme) {
    case "ws:":
    case "wss:":
      wsScheme = scheme;
      break;
    case "http:":
      wsScheme = "ws:";
      break;
    case "https:":
      wsScheme = "wss:";
      break;
    default:
      throw new Error(`Unsupported scheme "${scheme}"`);
  }

  if (!url.hostname) {
    throw new Error("Endpoint is missing a host");
  }

  const path = url.pathname && url.pathname !== "/" ? url.pathname : "/ws";
  const port = url.port ? `:${url.port}` : "";
  return `${wsScheme}//${url.hostname}${port}${path}`;
}
