/**
 * Owner-side store for read-only session share links.
 *
 * Creating a share captures the session once and writes it to disk; the link
 * then serves that frozen copy until it expires or is revoked. Nothing reads
 * the live session after capture, so a share never leaks later turns.
 *
 * Layout under `{dataDir}/session-shares/`:
 *   index.json            owner records (token -> session, expiry)
 *   snapshots/<token>.json frozen snapshot bodies
 *
 * Both are owner-only (0700 dir / 0600 files): the token in a file name is the
 * whole credential for that link.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type PublicSessionShareResponse,
  type SessionShareExpiry,
  type SessionShareRecord,
  type SessionShareSnapshot,
  fromUrlProjectId,
  isSessionShareToken,
  isUrlProjectId,
  resolveSessionShareExpiresAt,
} from "@yep-anywhere/shared";
import type { SessionPayloadLoader } from "./session-payload-loader.js";

export interface SessionShareServiceOptions {
  dataDir: string;
  loadSession: SessionPayloadLoader;
  now?: () => number;
}

export interface CreateSessionShareInput {
  projectId: string;
  sessionId: string;
  expiresIn: SessionShareExpiry;
  /** Title as the owner sees it; the stored session title is the fallback. */
  title?: string | null;
}

export type CreateSessionShareResult =
  | { ok: true; record: SessionShareRecord }
  | { ok: false; status: number; error: string };

interface ShareIndexFile {
  version: 1;
  shares: SessionShareRecord[];
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function projectNameFromId(projectId: string): string | undefined {
  if (!isUrlProjectId(projectId)) return undefined;
  try {
    const decoded = fromUrlProjectId(projectId);
    return path.basename(decoded) || undefined;
  } catch {
    return undefined;
  }
}

export class SessionShareService {
  private readonly rootDir: string;
  private readonly snapshotsDir: string;
  private readonly indexPath: string;
  private readonly loadSession: SessionPayloadLoader;
  private readonly now: () => number;
  /** Serializes index read-modify-write cycles within this process. */
  private indexQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionShareServiceOptions) {
    this.rootDir = path.join(options.dataDir, "session-shares");
    this.snapshotsDir = path.join(this.rootDir, "snapshots");
    this.indexPath = path.join(this.rootDir, "index.json");
    this.loadSession = options.loadSession;
    this.now = options.now ?? Date.now;
  }

  async create(
    input: CreateSessionShareInput,
  ): Promise<CreateSessionShareResult> {
    const loaded = await this.loadSession(input.projectId, input.sessionId);
    if (!loaded.ok) {
      return { ok: false, status: loaded.status, error: loaded.error };
    }

    const { session, messages, mediaOmitted, truncated } = loaded.payload;
    const createdAtMs = this.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const title =
      pickString(input.title) ??
      pickString(session.customTitle) ??
      pickString(session.title) ??
      pickString(session.aiTitle) ??
      null;
    const provider = pickString(session.provider);

    const snapshot: SessionShareSnapshot = {
      version: 1,
      capturedAt: createdAt,
      session: {
        title,
        provider,
        model: pickString(session.model),
        projectName: projectNameFromId(input.projectId),
        createdAt: pickString(session.createdAt),
        updatedAt: pickString(session.updatedAt),
      },
      messages,
      ...(mediaOmitted && { mediaOmitted: true }),
      ...(truncated && { truncated: true }),
    };
    const body = JSON.stringify(snapshot);

    const record: SessionShareRecord = {
      token: randomBytes(18).toString("base64url"),
      projectId: input.projectId,
      sessionId: input.sessionId,
      title,
      provider,
      createdAt,
      expiresAt: resolveSessionShareExpiresAt(input.expiresIn, createdAtMs),
      messageCount: messages.length,
      sizeBytes: Buffer.byteLength(body, "utf8"),
    };

    await this.ensureDirs();
    await this.writeFileAtomic(this.snapshotPath(record.token), body);
    await this.mutateIndex((shares) => [...shares, record]);
    return { ok: true, record };
  }

  /** Active shares, newest first, optionally scoped to one session. */
  async list(filter?: {
    projectId?: string;
    sessionId?: string;
  }): Promise<SessionShareRecord[]> {
    const shares = await this.pruneExpired();
    return shares
      .filter(
        (share) =>
          (!filter?.projectId || share.projectId === filter.projectId) &&
          (!filter?.sessionId || share.sessionId === filter.sessionId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revoke(token: string): Promise<boolean> {
    if (!isSessionShareToken(token)) return false;
    let found = false;
    await this.mutateIndex((shares) => {
      found = shares.some((share) => share.token === token);
      return shares.filter((share) => share.token !== token);
    });
    await fs.rm(this.snapshotPath(token), { force: true });
    return found;
  }

  /** Public view of a live share, or null when unknown/expired/revoked. */
  async getPublic(token: string): Promise<PublicSessionShareResponse | null> {
    if (!isSessionShareToken(token)) return null;
    const shares = await this.readIndex();
    const record = shares.find((share) => share.token === token);
    if (!record) return null;
    if (this.isExpired(record)) {
      void this.pruneExpired().catch(() => undefined);
      return null;
    }
    let snapshot: SessionShareSnapshot;
    try {
      snapshot = JSON.parse(
        await fs.readFile(this.snapshotPath(token), "utf8"),
      ) as SessionShareSnapshot;
    } catch {
      return null;
    }
    return {
      share: { createdAt: record.createdAt, expiresAt: record.expiresAt },
      snapshot,
    };
  }

  private isExpired(record: SessionShareRecord): boolean {
    return (
      record.expiresAt !== null && Date.parse(record.expiresAt) <= this.now()
    );
  }

  private async pruneExpired(): Promise<SessionShareRecord[]> {
    const expired: string[] = [];
    const remaining = await this.mutateIndex((shares) => {
      const keep: SessionShareRecord[] = [];
      for (const share of shares) {
        if (this.isExpired(share)) expired.push(share.token);
        else keep.push(share);
      }
      return keep;
    });
    await Promise.all(
      expired.map((token) =>
        fs.rm(this.snapshotPath(token), { force: true }).catch(() => undefined),
      ),
    );
    return remaining;
  }

  private snapshotPath(token: string): string {
    return path.join(this.snapshotsDir, `${token}.json`);
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true, mode: 0o700 });
  }

  private async readIndex(): Promise<SessionShareRecord[]> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.indexPath, "utf8"),
      ) as Partial<ShareIndexFile>;
      return Array.isArray(parsed.shares)
        ? parsed.shares.filter(
            (share): share is SessionShareRecord =>
              typeof share?.token === "string" &&
              isSessionShareToken(share.token),
          )
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Read-modify-write the index. The file is re-read every time rather than
   * cached, so a second Yep process sharing the data dir is never clobbered
   * by a stale in-memory copy.
   */
  private mutateIndex(
    update: (shares: SessionShareRecord[]) => SessionShareRecord[],
  ): Promise<SessionShareRecord[]> {
    const run = this.indexQueue.then(async () => {
      const current = await this.readIndex();
      const next = update(current);
      const changed =
        next.length !== current.length ||
        next.some((share, index) => share !== current[index]);
      if (changed) {
        await this.ensureDirs();
        const file: ShareIndexFile = { version: 1, shares: next };
        await this.writeFileAtomic(
          this.indexPath,
          `${JSON.stringify(file, null, 2)}\n`,
        );
      }
      return next;
    });
    this.indexQueue = run.catch(() => undefined);
    return run;
  }

  private async writeFileAtomic(target: string, data: string): Promise<void> {
    const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, target);
  }
}
