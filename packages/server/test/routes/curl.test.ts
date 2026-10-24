import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCurlCommand, serializeCurlRequest } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurlRoutes } from "../../src/routes/curl.js";
import { CurlService, executeCurl } from "../../src/services/CurlService.js";

describe("cURL requests with the real curl binary", () => {
  let directory: string;
  let server: Server;
  let origin: string;
  let received: {
    url?: string;
    method?: string;
    body: string;
    auth?: string;
    custom?: string;
  }[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "yep-curl-test-"));
    received = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({
        url: req.url,
        method: req.method,
        body: Buffer.concat(chunks).toString(),
        auth: req.headers.authorization,
        custom: req.headers["x-custom"] as string | undefined,
      });
      if (req.url === "/wait") return;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/echo" });
        res.end();
        return;
      }
      if (req.url === "/large") {
        res.end(Buffer.alloc(3 * 1024 * 1024, 97));
        return;
      }
      res.writeHead(req.url === "/error" ? 401 : 200, {
        "content-type": "application/json",
        "x-result": "yes",
      });
      res.end(JSON.stringify({ echoed: received.at(-1), message: "你好" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const input = (command: string, name = "Test") => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, name, runId: randomUUID() }),
  });
  const commandFor = (url: string) => `curl --noproxy '*' '${url}'`;

  it("executes multiline bodies literally and stores history with private permissions", async () => {
    const request = parseCurlCommand(commandFor(`${origin}/echo`));
    request.method = "POST";
    request.headers = [
      "Authorization: Bearer test-only-key",
      'X-Custom: "quoted" \\ literal',
    ];
    request.body = JSON.stringify(
      { text: "hello\n你好", literal: "$(do-not-run) `literal` 'quote'" },
      null,
      2,
    );
    const app = createCurlRoutes(directory);
    const result = await app.request(
      "/execute",
      input(serializeCurlRequest(request)),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const data = await result.json();
    expect(data.response).toMatchObject({
      status: 200,
      error: null,
      truncated: false,
    });
    expect(received[0]).toMatchObject({
      body: request.body,
      method: "POST",
      auth: "Bearer test-only-key",
      custom: '"quoted" \\ literal',
    });
    expect(data.response.headers).toContain("x-result: yes");
    const restored = await new CurlService(directory).list();
    expect(restored[0]?.command).toBe(serializeCurlRequest(request));
    expect(restored[0]?.run?.status).toBe(200);
    if (process.platform !== "win32")
      expect(
        (await stat(join(directory, "curl/history.json"))).mode & 0o777,
      ).toBe(0o600);
  });

  it("preserves HTTP errors and supports redirect and HEAD semantics", async () => {
    const app = createCurlRoutes(directory);
    const failed = await (
      await app.request("/execute", input(commandFor(`${origin}/error`)))
    ).json();
    expect(failed.response).toMatchObject({ status: 401, error: null });
    expect(JSON.parse(failed.response.body).message).toBe("你好");
    const redirected = await (
      await app.request(
        "/execute",
        input(`${commandFor(`${origin}/redirect`)} -L`),
      )
    ).json();
    expect(redirected.response.status).toBe(200);
    expect(redirected.response.headers).toContain("302");
    const head = await executeCurl(
      parseCurlCommand(`${commandFor(`${origin}/echo`)} -I`),
      new AbortController().signal,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(received.at(-1)?.method).toBe("HEAD");
  });

  it("honors an edited bypass domain and distinguishes explicit empty from inherited no-proxy rules", async () => {
    let proxyRequests = 0;
    const proxy = createServer((request, response) => {
      request.resume();
      proxyRequests++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ viaProxy: true }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("No proxy address");
      const request = parseCurlCommand(commandFor(`${origin}/echo`));
      request.proxy = `http://127.0.0.1:${address.port}`;
      vi.stubEnv("NO_PROXY", "127.0.0.1");
      vi.stubEnv("no_proxy", "127.0.0.1");
      request.noProxy = "127.0.0.1";
      const direct = await executeCurl(request, new AbortController().signal);
      expect(direct.error).toBeNull();
      expect(proxyRequests).toBe(0);
      expect(received).toHaveLength(1);

      request.noProxy = "";
      const proxied = await executeCurl(request, new AbortController().signal);
      expect(proxied.error).toBeNull();
      expect(JSON.parse(proxied.body)).toEqual({ viaProxy: true });
      expect(proxyRequests).toBe(1);

      request.noProxy = null;
      const inherited = await executeCurl(
        request,
        new AbortController().signal,
      );
      expect(inherited.error).toBeNull();
      expect(proxyRequests).toBe(1);
      expect(received).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("cancels its own active request and records cancellation", async () => {
    const service = new CurlService(directory);
    const id = randomUUID();
    const pending = service.execute("Slow", commandFor(`${origin}/wait`), id);
    await new Promise<void>((resolve) =>
      server.once("request", () => resolve()),
    );
    expect(service.cancel(id)).toBe(true);
    const result = await pending;
    expect(result.response.error).toBe("cancelled");
    expect((await service.list())[0]?.run?.error).toBe("cancelled");
    expect(service.cancel(id)).toBe(false);
  });

  it("bounds response sizes and timeouts", async () => {
    const large = await executeCurl(
      parseCurlCommand(commandFor(`${origin}/large`)),
      new AbortController().signal,
    );
    expect(large.error).toBe("tooLarge");
    expect(large.size).toBeLessThanOrEqual(2 * 1024 * 1024);
    const slow = await executeCurl(
      parseCurlCommand(`${commandFor(`${origin}/wait`)} -m 0.1`),
      new AbortController().signal,
    );
    expect(slow.error).toBe("timeout");
  });

  it("rejects unsafe inputs before any network request and edits/deletes saved commands", async () => {
    const app = createCurlRoutes(directory);
    for (const command of [
      `${commandFor(origin)} -d @/etc/passwd`,
      `${commandFor(origin)} --config /tmp/x`,
      "curl file:///etc/passwd",
    ]) {
      const result = await app.request("/execute", input(command));
      expect(result.status).toBe(400);
    }
    expect(received).toHaveLength(0);
    const saved = await (
      await app.request("/templates", input(commandFor(origin)))
    ).json();
    const updated = await app.request(`/templates/${saved.entry.id}`, {
      ...input(commandFor(`${origin}/new`), "Renamed"),
      method: "PUT",
    });
    expect((await updated.json()).entry.name).toBe("Renamed");
    expect((await (await app.request("/")).json()).templates).toHaveLength(1);
    expect(
      (await app.request(`/templates/${saved.entry.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(await (await app.request("/")).json()).toEqual({
      entries: [],
      templates: [],
    });
  });

  it("serializes concurrent saves and does not overwrite corrupt history or send a request", async () => {
    const service = new CurlService(directory);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.save(String(i), commandFor(origin)),
      ),
    );
    expect((await service.listAll()).templates).toHaveLength(8);
    expect(await service.list()).toHaveLength(0);
    const file = join(directory, "curl/history.json");
    await writeFile(file, "not json");
    const result = await createCurlRoutes(directory).request(
      "/execute",
      input(commandFor(origin)),
    );
    expect(result.status).toBe(500);
    expect(received).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  it("keeps templates independent from executions, updates and deletions", async () => {
    const app = createCurlRoutes(directory);
    const { entry: template } = await (
      await app.request(
        "/templates",
        input(commandFor(`${origin}/echo`), "Reusable"),
      )
    ).json();
    const changedCommand = `${commandFor(`${origin}/error`)} -H 'X-Custom: run only'`;
    const { entry: history } = await (
      await app.request("/execute", input(changedCommand, "One run"))
    ).json();
    expect(history.run.status).toBe(401);
    expect(history.id).not.toBe(template.id);
    expect(await (await app.request("/")).json()).toEqual({
      templates: [template],
      entries: [history],
    });
    expect(
      (
        await app.request(`/templates/${history.id}`, {
          ...input(commandFor(origin)),
          method: "PUT",
        })
      ).status,
    ).toBe(404);
    const updated = await (
      await app.request(`/templates/${template.id}`, {
        ...input(commandFor(`${origin}/new`), "Updated template"),
        method: "PUT",
      })
    ).json();
    expect(updated.entry.name).toBe("Updated template");
    expect((await (await app.request("/")).json()).entries).toEqual([history]);

    expect(
      (await app.request(`/history/${template.id}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    await app.request(`/history/${history.id}`, { method: "DELETE" });
    expect(await (await app.request("/")).json()).toEqual({
      templates: [updated.entry],
      entries: [],
    });
    const nextRun = await (
      await app.request("/execute", input(template.command))
    ).json();
    await app.request(`/templates/${template.id}`, { method: "DELETE" });
    expect(await (await app.request("/")).json()).toEqual({
      templates: [],
      entries: [nextRun.entry],
    });
  });

  it("splits legacy saved rows from runs without losing IDs or migrating unfinished new runs into templates", async () => {
    const service = new CurlService(directory);
    const template = await service.save("Saved", commandFor(origin));
    const oldRun = {
      ...template,
      id: randomUUID(),
      name: "Sent",
      run: { status: 200, durationMs: 5, error: null },
    };
    const file = join(directory, "curl/history.json");
    const legacy = JSON.stringify({
      entries: [oldRun, { ...template, run: null }],
    });
    await writeFile(file, legacy);
    expect(await service.listAll()).toEqual({
      templates: [template],
      entries: [oldRun],
    });
    expect(await readFile(file, "utf8")).toBe(legacy);
    const secondTemplate = await service.save("Another", commandFor(origin));
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored).toEqual({
      version: 2,
      templates: [secondTemplate, template],
      entries: [oldRun],
    });
    stored.entries.unshift({ ...oldRun, id: randomUUID(), run: null });
    await writeFile(file, JSON.stringify(stored));
    const restored = await new CurlService(directory).listAll();
    expect(restored.templates).toEqual(stored.templates);
    expect(restored.entries).toEqual(stored.entries);
  });

  it("bounds only execution history and never evicts manually saved templates", async () => {
    const service = new CurlService(directory);
    const seed = await service.save("Seed", commandFor(origin));
    const templates = Array.from({ length: 101 }, () => ({
      ...seed,
      id: randomUUID(),
    }));
    const entries = Array.from({ length: 100 }, () => ({
      ...seed,
      id: randomUUID(),
      run: { status: 200, durationMs: 1, error: null },
    }));
    await writeFile(
      join(directory, "curl/history.json"),
      JSON.stringify({
        version: 2,
        templates,
        entries,
      }),
    );
    const added = await service.save("Keep me", commandFor(origin));
    const result = await service.execute(
      "New run",
      commandFor(origin),
      randomUUID(),
    );
    const restored = await new CurlService(directory).listAll();
    expect(restored.templates).toEqual([added, ...templates]);
    expect(restored.entries).toEqual([result.entry, ...entries.slice(0, 99)]);
  });
});
