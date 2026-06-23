import { loadConfig } from "../config.js";
import { CodexBridgeService } from "./CodexBridgeService.js";

export async function runCodexBridgeOnly(): Promise<void> {
  const config = loadConfig();
  const bridge = new CodexBridgeService({
    enabled: true,
    host: config.codexBridgeHost,
    port: config.codexBridgePort,
    upstreamUrl: config.codexBridgeUpstreamUrl,
    upstreamStartPort: config.codexBridgeUpstreamStartPort,
    lightUpstreamArgs: config.codexBridgeLightUpstreamArgs,
    fullUpstreamArgs: config.codexBridgeFullUpstreamArgs,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[CodexBridge] Received ${signal}, shutting down...`);
    await bridge.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await bridge.start();
  const status = bridge.getStatus();
  if (!status.listening) {
    console.error(
      `[CodexBridge] Failed to start on ${status.url}: ${status.lastError ?? "unknown error"}`,
    );
    process.exit(1);
  }

  console.log(`[CodexBridge] Standalone bridge running at ${status.url}`);
}
