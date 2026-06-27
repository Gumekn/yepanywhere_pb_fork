/**
 * NativePushService - Android native push via FCM HTTP v1.
 *
 * This intentionally avoids firebase-admin to keep the server bundle small.
 * Credentials are read from private runtime configuration:
 * - YEP_FCM_SERVICE_ACCOUNT_JSON: raw service account JSON
 * - YEP_FCM_SERVICE_ACCOUNT_FILE: path to service account JSON
 * - GOOGLE_APPLICATION_CREDENTIALS: path to service account JSON
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  NativePushSubscriptionState,
  PushPayload,
  SendResult,
  StoredNativePushSubscription,
  TestNotificationUrgency,
} from "./types.js";

const CURRENT_VERSION = 1;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface FcmAccessToken {
  accessToken: string;
  expiresAtMs: number;
}

interface FcmAndroidConfig {
  priority: "HIGH";
  ttl: string;
  collapse_key?: string;
}

export interface NativePushServiceOptions {
  /** Directory to store subscription data (defaults to ~/.yep-anywhere). */
  dataDir?: string;
  /** Test seam for network calls. */
  fetchImpl?: typeof fetch;
  /** Test seam for credentials. If omitted, runtime env is checked. */
  serviceAccount?: FcmServiceAccount | null;
}

export class NativePushService {
  private state: NativePushSubscriptionState;
  private dataDir: string;
  private filePath: string;
  private initialized = false;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;
  private fetchImpl: typeof fetch;
  private serviceAccount: FcmServiceAccount | null | undefined;
  private cachedToken: FcmAccessToken | null = null;

  constructor(options: NativePushServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "native-push-subscriptions.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.serviceAccount = options.serviceAccount;
    this.state = { version: CURRENT_VERSION, subscriptions: {} };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as NativePushSubscriptionState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        this.state = {
          version: CURRENT_VERSION,
          subscriptions: parsed.subscriptions ?? {},
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[NativePushService] Failed to load subscriptions, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, subscriptions: {} };
    }

    if (this.serviceAccount === undefined) {
      this.serviceAccount = await loadFcmServiceAccountFromEnv();
    }

    this.initialized = true;
  }

  isConfigured(): boolean {
    return !!this.serviceAccount;
  }

  async subscribe(
    browserProfileId: string,
    token: string,
    options: { deviceName?: string } = {},
  ): Promise<void> {
    this.ensureInitialized();

    const existing = this.state.subscriptions[browserProfileId];
    const now = new Date().toISOString();

    this.state.subscriptions[browserProfileId] = {
      platform: "android",
      token,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deviceName: options.deviceName,
    };

    await this.save();
  }

  async unsubscribe(browserProfileId: string): Promise<boolean> {
    this.ensureInitialized();

    if (!this.state.subscriptions[browserProfileId]) {
      return false;
    }

    delete this.state.subscriptions[browserProfileId];
    await this.save();
    return true;
  }

  getSubscriptions(): Record<string, StoredNativePushSubscription> {
    this.ensureInitialized();
    return { ...this.state.subscriptions };
  }

  getSubscriptionCount(): number {
    return Object.keys(this.state.subscriptions).length;
  }

  isSubscribed(browserProfileId: string): boolean {
    return !!this.state.subscriptions[browserProfileId];
  }

  async sendToAll(
    payload: PushPayload,
    options?: { excludeBrowserProfileIds?: string[] },
  ): Promise<SendResult[]> {
    this.ensureInitialized();

    const excludeSet = new Set(options?.excludeBrowserProfileIds ?? []);
    const browserProfileIds = Object.keys(this.state.subscriptions).filter(
      (id) => !excludeSet.has(id),
    );

    if (browserProfileIds.length === 0) {
      return [];
    }

    const results = await Promise.all(
      browserProfileIds.map((browserProfileId) =>
        this.sendToBrowserProfile(browserProfileId, payload),
      ),
    );

    await this.cleanupInvalidSubscriptions(results);
    return results;
  }

  async sendToBrowserProfile(
    browserProfileId: string,
    payload: PushPayload,
  ): Promise<SendResult> {
    this.ensureInitialized();

    if (!this.serviceAccount) {
      return {
        browserProfileId,
        success: false,
        error:
          "FCM credentials not configured. Set YEP_FCM_SERVICE_ACCOUNT_JSON or YEP_FCM_SERVICE_ACCOUNT_FILE.",
      };
    }

    const stored = this.state.subscriptions[browserProfileId];
    if (!stored) {
      return {
        browserProfileId,
        success: false,
        error: "Browser profile not subscribed for native push",
      };
    }

    try {
      const accessToken = await this.getAccessToken(this.serviceAccount);
      const response = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
          this.serviceAccount.project_id,
        )}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: stored.token,
              data: toFcmData(payload),
              android: toFcmAndroidConfig(payload),
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          browserProfileId,
          success: false,
          statusCode: response.status,
          error: body || `FCM error: ${response.status}`,
        };
      }

      return {
        browserProfileId,
        success: true,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        browserProfileId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async sendTest(
    browserProfileId: string,
    message = "Test notification from Yep Anywhere",
    urgency?: TestNotificationUrgency,
  ): Promise<SendResult> {
    return this.sendToBrowserProfile(browserProfileId, {
      type: "test",
      message,
      urgency,
      timestamp: new Date().toISOString(),
    });
  }

  getFilePath(): string {
    return this.filePath;
  }

  private async getAccessToken(
    serviceAccount: FcmServiceAccount,
  ): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - now > 60_000) {
      return this.cachedToken.accessToken;
    }

    const tokenUri = serviceAccount.token_uri ?? DEFAULT_TOKEN_URI;
    const assertion = createServiceAccountJwt(serviceAccount, tokenUri);
    const response = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        body || `Failed to fetch FCM access token: ${response.status}`,
      );
    }

    const tokenResponse = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!tokenResponse.access_token) {
      throw new Error("FCM token response missing access_token");
    }

    this.cachedToken = {
      accessToken: tokenResponse.access_token,
      expiresAtMs: now + (tokenResponse.expires_in ?? 3600) * 1000,
    };
    return this.cachedToken.accessToken;
  }

  private async cleanupInvalidSubscriptions(
    results: SendResult[],
  ): Promise<void> {
    const invalidProfiles = results.filter(
      (r) =>
        !r.success &&
        (r.statusCode === 404 ||
          r.statusCode === 410 ||
          r.error?.includes("UNREGISTERED")),
    );

    if (invalidProfiles.length === 0) return;

    for (const { browserProfileId } of invalidProfiles) {
      delete this.state.subscriptions[browserProfileId];
      console.log(
        `[NativePushService] Removed expired native subscription: ${browserProfileId}`,
      );
    }

    await this.save();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "NativePushService not initialized. Call initialize() first.",
      );
    }
  }

  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[NativePushService] Failed to save subscriptions:", error);
      throw error;
    }
  }
}

async function loadFcmServiceAccountFromEnv(): Promise<FcmServiceAccount | null> {
  const rawJson = process.env.YEP_FCM_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    return parseServiceAccount(rawJson, "YEP_FCM_SERVICE_ACCOUNT_JSON");
  }

  const filePath =
    process.env.YEP_FCM_SERVICE_ACCOUNT_FILE ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!filePath) return null;

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseServiceAccount(content, filePath);
  } catch (error) {
    console.warn(
      `[NativePushService] Failed to load FCM service account from ${filePath}:`,
      error,
    );
    return null;
  }
}

function parseServiceAccount(
  content: string,
  source: string,
): FcmServiceAccount | null {
  try {
    const parsed = JSON.parse(content) as Partial<FcmServiceAccount>;
    if (
      typeof parsed.project_id !== "string" ||
      typeof parsed.client_email !== "string" ||
      typeof parsed.private_key !== "string"
    ) {
      console.warn(
        `[NativePushService] Invalid FCM service account in ${source}: missing project_id, client_email, or private_key`,
      );
      return null;
    }
    return {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      token_uri: parsed.token_uri,
    };
  } catch (error) {
    console.warn(
      `[NativePushService] Failed to parse FCM service account from ${source}:`,
      error,
    );
    return null;
  }
}

function createServiceAccountJwt(
  serviceAccount: FcmServiceAccount,
  tokenUri: string,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(serviceAccount.private_key, "base64url");
  return `${unsigned}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function toFcmData(payload: PushPayload): Record<string, string> {
  const data: Record<string, string> = {
    type: payload.type,
    timestamp: payload.timestamp,
    payload: JSON.stringify(payload),
  };

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    data[key] = String(value);
  }

  return data;
}

function toFcmAndroidConfig(payload: PushPayload): FcmAndroidConfig {
  return {
    priority: "HIGH",
    ttl: toFcmTtl(payload),
    collapse_key: toFcmCollapseKey(payload),
  };
}

function toFcmTtl(payload: PushPayload): string {
  if (payload.type === "pending-input") return "3600s";
  if (payload.type === "session-halted") return "600s";
  if (payload.type === "dismiss") return "60s";
  return "300s";
}

function toFcmCollapseKey(payload: PushPayload): string | undefined {
  if ("sessionId" in payload && payload.sessionId) {
    return `session-${payload.sessionId}`;
  }
  if (payload.type === "test") return "test";
  return undefined;
}
