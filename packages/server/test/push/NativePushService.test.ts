import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativePushService } from "../../src/push/NativePushService.js";

describe("NativePushService", () => {
  let tempDir: string;
  let service: NativePushService;
  let fetchImpl: ReturnType<typeof vi.fn>;

  const serviceAccount = {
    project_id: "test-project",
    client_email: "fcm@test-project.iam.gserviceaccount.com",
    private_key: createPrivateKey(),
    token_uri: "https://oauth2.googleapis.com/token",
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-push-test-"));
    fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ name: "messages/1" }), {
        status: 200,
      });
    });

    service = new NativePushService({
      dataDir: tempDir,
      serviceAccount,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("initializes with empty subscriptions", () => {
    expect(service.getSubscriptionCount()).toBe(0);
    expect(service.isConfigured()).toBe(true);
  });

  it("subscribes and persists an Android token", async () => {
    await service.subscribe("profile-1", "fcm-token", {
      deviceName: "Android APK",
    });

    expect(service.isSubscribed("profile-1")).toBe(true);
    expect(service.getSubscriptionCount()).toBe(1);

    const content = await fs.readFile(service.getFilePath(), "utf-8");
    const saved = JSON.parse(content);
    expect(saved.subscriptions["profile-1"].platform).toBe("android");
    expect(saved.subscriptions["profile-1"].token).toBe("fcm-token");
  });

  it("updates an existing token without changing createdAt", async () => {
    await service.subscribe("profile-1", "old-token");
    const before = service.getSubscriptions()["profile-1"]?.createdAt;

    await service.subscribe("profile-1", "new-token");

    const stored = service.getSubscriptions()["profile-1"];
    expect(stored?.token).toBe("new-token");
    expect(stored?.createdAt).toBe(before);
    expect(stored?.updatedAt).toBeDefined();
  });

  it("sends an FCM HTTP v1 data message", async () => {
    await service.subscribe("profile-1", "fcm-token");

    const result = await service.sendToBrowserProfile("profile-1", {
      type: "test",
      message: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sendCall = fetchImpl.mock.calls[1];
    expect(String(sendCall[0])).toContain(
      "https://fcm.googleapis.com/v1/projects/test-project/messages:send",
    );
    const body = JSON.parse(sendCall[1].body);
    expect(body.message.token).toBe("fcm-token");
    expect(body.message.data.type).toBe("test");
    expect(body.message.notification).toBeUndefined();
    expect(body.message.android.priority).toBe("HIGH");
    expect(body.message.android.notification).toBeUndefined();
    expect(body.message.android.ttl).toBe("300s");
    expect(body.message.android.collapse_key).toBe("test");
  });

  it("returns an error when credentials are not configured", async () => {
    const noCredsService = new NativePushService({
      dataDir: tempDir,
      serviceAccount: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await noCredsService.initialize();
    await noCredsService.subscribe("profile-1", "fcm-token");

    const result = await noCredsService.sendToBrowserProfile("profile-1", {
      type: "test",
      message: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("FCM credentials not configured");
  });

  it("cleans up invalid native subscriptions", async () => {
    fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          error: {
            status: "NOT_FOUND",
            details: [{ errorCode: "UNREGISTERED" }],
          },
        }),
        { status: 404 },
      );
    });

    service = new NativePushService({
      dataDir: tempDir,
      serviceAccount,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await service.initialize();
    await service.subscribe("profile-1", "expired-token");

    await service.sendToAll({
      type: "test",
      message: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(service.isSubscribed("profile-1")).toBe(false);
  });
});

function createPrivateKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
