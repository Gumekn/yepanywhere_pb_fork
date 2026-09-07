/**
 * CLI setup commands for headless authentication configuration.
 *
 * These commands allow setting up auth without the web interface,
 * useful for headless/automated deployments.
 */

import { AuthService } from "./auth/AuthService.js";
import { getDataDir } from "./config.js";

export interface SetupAuthOptions {
  password: string;
}

/**
 * Set up local cookie-based authentication.
 * Creates or updates the password in auth.json.
 */
export async function setupAuth(options: SetupAuthOptions): Promise<void> {
  const { password } = options;

  if (!password || password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const dataDir = getDataDir();
  const authService = new AuthService({ dataDir });
  await authService.initialize();

  await authService.enableAuth(password);
  console.log("Local authentication configured successfully.");
  console.log(`Auth file: ${authService.getFilePath()}`);
}
