import { loadConfig } from "../config.js";
import { ClaudeBridgeService } from "./ClaudeBridgeService.js";

export async function runClaudeBridgeOnly(): Promise<void> {
  const config = loadConfig();
  const bridge = new ClaudeBridgeService({
    enabled: true,
    host: config.claudeBridgeHost,
    port: config.claudeBridgePort,
    serverUrl: config.claudeBridgeServerUrl,
    desktopToken: config.desktopAuthToken,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ClaudeBridge] Received ${signal}, shutting down...`);
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
      `[ClaudeBridge] Failed to start on ${status.url}: ${status.lastError ?? "unknown error"}`,
    );
    process.exit(1);
  }

  console.log(
    `[ClaudeBridge] Standalone bridge running at ${status.url}, server=${status.serverUrl}`,
  );
}
