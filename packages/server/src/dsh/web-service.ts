import { execFile, spawn } from "node:child_process";
import { closeSync, fchmodSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "../utils/fileLock.js";
import { findDshCliPath } from "./cli.js";

export interface DshConnection {
  origin: string;
  cookie: string;
}

export class DshWebError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

interface ProcessRecord {
  pid: number;
  executable?: string;
}

// Yep always presents DSH through a proxy. A loopback bind on macOS otherwise
// makes DSH choose an OS dialog on the server, invisible to the remote user.
const WEB_PICKER_PATCH = `- id: directory-picker
  disabled: true
- insert:
    - id: yep-directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: yep-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`;

/** A detached, loopback-only Web process. Never takes over an existing DSH port. */
export class DshWebService {
  private connection?: DshConnection;
  private starting?: Promise<DshConnection>;
  private updating = false;
  private readonly recordPath: string;
  private readonly logPath: string;

  constructor(private readonly directory: string) {
    this.recordPath = join(directory, "process.json");
    this.logPath = join(directory, "web.log");
  }

  async launch(): Promise<DshConnection> {
    if (this.updating) throw new DshWebError("DSH_UPDATING");
    if (this.starting) return this.starting;
    this.starting = mkdir(this.directory, { recursive: true, mode: 0o700 })
      .then(() =>
        withFileLock(this.directory, () => this.ensureRunning(), {
          retries: 5,
        }),
      )
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  /** Resource requests never start processes; only the authenticated POST does. */
  async getConnection(): Promise<DshConnection> {
    if (this.updating) throw new DshWebError("DSH_UPDATING");
    if (this.connection) return this.connection;
    const record = await this.readRecord();
    if (!record || !this.isAlive(record.pid)) {
      throw new DshWebError("DSH_NOT_RUNNING");
    }
    return this.connect();
  }

  async isRunning(): Promise<boolean> {
    const record = await this.readRecord();
    return Boolean(record && this.isAlive(record.pid));
  }

  /** Explicit user action only. Never discovers or stops unrelated DSH processes. */
  async stop(): Promise<void> {
    if (this.updating) throw new DshWebError("DSH_UPDATING");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await withFileLock(
      this.directory,
      async () => {
        const record = await this.readRecord();
        if (!record || !this.isAlive(record.pid)) {
          this.connection = undefined;
          return;
        }
        const executable = record.executable ?? (await findDshCliPath());
        const { stdout } = await promisify(execFile)(
          "ps",
          ["-p", String(record.pid), "-o", "command="],
          { timeout: 5_000 },
        );
        // PID reuse must not turn a stale record into authority to stop another
        // service. The managed patch path distinguishes our Web process.
        if (
          !executable ||
          !stdout.includes(executable) ||
          !stdout.includes(" web ") ||
          !stdout.includes(join(this.directory, "web.patch.yml")) ||
          !stdout.includes("--host 127.0.0.1")
        ) {
          throw new DshWebError("DSH_PROCESS_NOT_OWNED");
        }
        await this.connect();
        process.kill(record.pid, "SIGTERM");
        const deadline = Date.now() + 10_000;
        while (this.isAlive(record.pid)) {
          if (Date.now() >= deadline) throw new DshWebError("DSH_STOP_TIMEOUT");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        this.connection = undefined;
      },
      { retries: 5 },
    );
  }

  /** Keep npm replacement and Web startup mutually exclusive, including across servers. */
  async withUpdateLock(update: () => Promise<void>): Promise<void> {
    if (this.updating) throw new DshWebError("DSH_UPDATING");
    this.updating = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await withFileLock(
        this.directory,
        async () => {
          if (await this.isRunning()) throw new DshWebError("DSH_WEB_RUNNING");
          this.connection = undefined;
          await update();
        },
        { retries: 5 },
      );
    } finally {
      this.updating = false;
    }
  }

  private async readRecord(): Promise<ProcessRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.recordPath, "utf8"));
      if (Number.isSafeInteger(value.pid) && value.pid > 0) return value;
      throw new DshWebError("DSH_INVALID_STATE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async ensureRunning(): Promise<DshConnection> {
    const record = await this.readRecord();
    this.connection = undefined;
    if (record && this.isAlive(record.pid))
      return this.waitUntilReady(record.pid);

    const executable = await findDshCliPath();
    if (!executable) throw new DshWebError("DSH_NOT_INSTALLED");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const patchPath = join(this.directory, "web.patch.yml");
    await writeFile(patchPath, WEB_PICKER_PATCH, { mode: 0o600 });
    // The startup URL contains DSH's process credential. It stays on the server.
    const log = openSync(this.logPath, "w", 0o600);
    fchmodSync(log, 0o600);
    let spawnError = false;
    const child = spawn(
      executable,
      [
        "web",
        "--patch",
        patchPath,
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        cwd: homedir(),
        detached: true,
        stdio: ["ignore", log, log],
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
      },
    );
    child.on("error", () => {
      spawnError = true;
    });
    closeSync(log);
    child.unref();
    if (!child.pid) throw new DshWebError("DSH_START_FAILED");
    const temporary = `${this.recordPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ pid: child.pid, executable }), {
      mode: 0o600,
    });
    await rename(temporary, this.recordPath);
    if (spawnError) throw new DshWebError("DSH_START_FAILED");
    return this.waitUntilReady(child.pid);
  }

  private async waitUntilReady(pid: number): Promise<DshConnection> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) throw new DshWebError("DSH_START_FAILED");
      try {
        return await this.connect();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    // Leave the process alone: it may still be initializing or have live work.
    throw new DshWebError("DSH_START_TIMEOUT");
  }

  private async connect(): Promise<DshConnection> {
    const file = await open(this.logPath, "r");
    const buffer = Buffer.alloc(16 * 1024);
    let log: string;
    try {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      log = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
    const match = log.match(
      /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)\s*$/m,
    );
    if (!match?.[1]) throw new DshWebError("DSH_NOT_READY");
    const url = new URL(match[1]);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    if (response.status !== 303 || !cookie)
      throw new DshWebError("DSH_NOT_READY");
    this.connection = { origin: url.origin, cookie };
    return this.connection;
  }
}
