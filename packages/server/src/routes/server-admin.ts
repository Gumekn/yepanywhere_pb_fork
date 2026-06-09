import { Hono } from "hono";
import type { NotificationService } from "../notifications/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { getDeploymentAvailability, startDeploymentJob } from "./deploy.js";

export interface ServerAdminDeps {
  supervisor: Supervisor;
  notificationService?: NotificationService;
  dataDir?: string;
}

/**
 * Administrative routes for server management.
 * Always mounted (not dev-mode-only), so remote clients can use them.
 */
export function createServerAdminRoutes(deps: ServerAdminDeps): Hono {
  const routes = new Hono();

  // POST /api/server/restart - Trigger graceful server restart
  routes.post("/restart", async (c) => {
    console.log("[ServerAdmin] Restart requested via API");

    await deps.notificationService?.flush();

    const deployAvailable = getDeploymentAvailability({
      dataDir: deps.dataDir,
    }).available;
    if (process.env.NODE_ENV === "production" && deployAvailable) {
      const response = c.json({
        ok: true,
        message: "Server restart deploy job starting...",
      });

      setTimeout(() => {
        void startDeploymentJob(
          { dataDir: deps.dataDir },
          { action: "server" },
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[ServerAdmin] Failed to start restart job:", message);
        });
      }, 100);

      return response;
    }

    // Respond before exiting
    const response = c.json({
      ok: true,
      message: "Server restarting...",
    });

    // Schedule exit after response is sent.
    // Process supervisor (scripts/dev.js, systemd, pm2) will restart the process.
    setTimeout(() => {
      process.exit(0);
    }, 100);

    return response;
  });

  return routes;
}
