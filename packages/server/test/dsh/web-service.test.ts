import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshWebService } from "../../src/dsh/web-service.js";

describe("managed DSH Web process", () => {
  let directory: string;
  let state: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "yep-dsh-test-"));
    state = join(directory, "state");
    const executable = join(directory, "dsh");
    await writeFile(
      executable,
      `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(directory, "starts"))}, 'started\\n');
const server = http.createServer((req, res) => {
  if (req.url === '/?token=test-token') {
    res.writeHead(303, { 'set-cookie': 'dsh_session=private; HttpOnly', location: './' });
  } else res.writeHead(401);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=test-token');
});
`,
    );
    await chmod(executable, 0o700);
    vi.stubEnv("YEP_DSH_PATH", executable);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      const { pid } = JSON.parse(
        await readFile(join(state, "process.json"), "utf8"),
      );
      process.kill(pid, "SIGTERM");
    } catch {
      /* No test process was started. */
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("shares concurrent launches, then reattaches after the Yep service is recreated", async () => {
    const service = new DshWebService(state);
    const [first, second] = await Promise.all([
      service.launch(),
      service.launch(),
    ]);
    expect(first).toEqual(second);
    expect(first.cookie).toBe("dsh_session=private");
    expect(await new DshWebService(state).launch()).toEqual(first);
    expect(await new DshWebService(state).getConnection()).toEqual(first);
    expect(await readFile(join(directory, "starts"), "utf8")).toBe("started\n");
    expect((await stat(join(state, "web.log"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(state, "process.json"))).mode & 0o777).toBe(0o600);
  });

  it("coordinates separate managers using the same state directory", async () => {
    const [a, b] = await Promise.all([
      new DshWebService(state).launch(),
      new DshWebService(state).launch(),
    ]);
    expect(a.origin).toBe(b.origin);
    expect(await readFile(join(directory, "starts"), "utf8")).toBe("started\n");
  });

  it("does not start a process for resource requests", async () => {
    await expect(
      new DshWebService(state).getConnection(),
    ).rejects.toMatchObject({ code: "DSH_NOT_RUNNING" });
    await expect(readFile(join(directory, "starts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses installation changes until an explicit stop, then excludes launches during the update", async () => {
    const service = new DshWebService(state);
    await service.launch();
    const update = vi.fn(async () => {});
    await expect(service.withUpdateLock(update)).rejects.toMatchObject({
      code: "DSH_WEB_RUNNING",
    });
    expect(update).not.toHaveBeenCalled();
    expect(await service.isRunning()).toBe(true);
    await service.stop();
    expect(await service.isRunning()).toBe(false);
    await expect(service.getConnection()).rejects.toMatchObject({
      code: "DSH_NOT_RUNNING",
    });
    await service.withUpdateLock(async () => {
      await expect(service.launch()).rejects.toMatchObject({
        code: "DSH_UPDATING",
      });
    });
    await service.launch();
    expect(await service.isRunning()).toBe(true);
  });

  it("does not signal a different process referenced by a stale PID record", async () => {
    const service = new DshWebService(state);
    await service.launch();
    const recordPath = join(state, "process.json");
    const original = await readFile(recordPath, "utf8");
    try {
      await writeFile(recordPath, JSON.stringify({ pid: process.pid }));
      await expect(service.stop()).rejects.toMatchObject({
        code: "DSH_PROCESS_NOT_OWNED",
      });
    } finally {
      await writeFile(recordPath, original);
    }
  });

  it("reports a missing installation without invoking a shell or installer", async () => {
    vi.stubEnv("YEP_DSH_PATH", join(directory, "missing"));
    await expect(new DshWebService(state).launch()).rejects.toMatchObject({
      code: "DSH_NOT_INSTALLED",
    });
  });
});
