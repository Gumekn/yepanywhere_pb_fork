import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SessionMetadataState } from "../metadata/SessionMetadataService.js";
import type { ArchivedSessionRecord } from "./SessionArchiveService.js";

/** Compare bytes without loading potentially huge rollouts into memory. */
async function digest(path: string, length: number): Promise<string> {
  const hash = createHash("sha256");
  if (length > 0) {
    for await (const chunk of createReadStream(path, {
      start: 0,
      end: length - 1,
    })) {
      hash.update(chunk);
    }
  }
  return hash.digest("hex");
}

export async function verifyRestoredCodexArchive(
  record: ArchivedSessionRecord,
  allowAppended = false,
  restoredPaths: Record<string, string> = {},
): Promise<void> {
  if (record.provider !== "codex" || record.files.length === 0) {
    throw new Error(`Not a legacy Codex archive: ${record.sessionId}`);
  }
  for (const file of record.files) {
    const restoredPath = restoredPaths[file.originalPath] ?? file.originalPath;
    const [original, archived] = await Promise.all([
      stat(restoredPath),
      stat(file.archivePath),
    ]);
    if (
      file.directory ||
      !original.isFile() ||
      !archived.isFile() ||
      archived.size === 0 ||
      original.size < archived.size ||
      (!allowAppended && original.size !== archived.size) ||
      (await digest(restoredPath, archived.size)) !==
        (await digest(file.archivePath, archived.size))
    ) {
      throw new Error(`Restored Codex archive differs: ${record.sessionId}`);
    }
  }
}

interface MigrationIntent {
  version: 1;
  records: ArchivedSessionRecord[];
  restoredPaths?: Record<string, string>;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { flag: "wx", mode: 0o600 });
  try {
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/**
 * Only reconciles files already restored by the user. Never writes provider
 * files. Staging leaves an intent outside the legacy service's write paths:
 * the next new server replays it before loading either in-memory store.
 */
export async function reconcileRestoredCodexArchives(
  dataDir: string,
  mode: "stage" | "startup",
  restoredPaths: Record<string, string> = {},
): Promise<{ sessionIds: string[]; backupDir?: string; pending: boolean }> {
  const archiveDir = join(dataDir, "archive");
  const manifestPath = join(archiveDir, "manifest.json");
  const metadataPath = join(dataDir, "session-metadata.json");
  const intentPath = join(archiveDir, "codex-restored-migration.pending.json");
  const intentRaw = await readOptional(intentPath);
  if (mode === "startup" && !intentRaw) {
    return { sessionIds: [], pending: false };
  }
  const manifestRaw = await readFile(manifestPath, "utf8");
  const metadataRaw = await readFile(metadataPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as {
    version: number;
    sessions: Record<string, ArchivedSessionRecord>;
  };
  const metadata = JSON.parse(metadataRaw) as SessionMetadataState;
  if (manifest.version !== 1 || !manifest.sessions || !metadata.sessions) {
    throw new Error(
      "Invalid archive manifest or session metadata; refusing migration",
    );
  }
  const intent: MigrationIntent = intentRaw
    ? JSON.parse(intentRaw)
    : { version: 1, records: [] };
  if (intent.version !== 1 || !Array.isArray(intent.records)) {
    throw new Error("Invalid Codex migration intent");
  }
  const verifiedPaths = { ...intent.restoredPaths, ...restoredPaths };
  const records = new Map(
    intent.records.map((record) => [record.sessionId, record]),
  );
  if (mode === "stage") {
    for (const record of Object.values(manifest.sessions)) {
      if (record.provider === "codex") records.set(record.sessionId, record);
    }
  }
  if (records.size === 0) return { sessionIds: [], pending: false };
  for (const record of records.values()) {
    // A resumed rollout may have appended messages since staging. Its archived
    // prefix must still match; a rewritten/conflicting file needs manual review.
    await verifyRestoredCodexArchive(record, true, verifiedPaths);
    const current = manifest.sessions[record.sessionId];
    if (
      current &&
      (current.provider !== "codex" ||
        current.archivedAt !== record.archivedAt ||
        JSON.stringify(current.files) !== JSON.stringify(record.files))
    ) {
      throw new Error(`Archive changed since migration: ${record.sessionId}`);
    }
    delete manifest.sessions[record.sessionId];
    metadata.sessions[record.sessionId] = {
      ...metadata.sessions[record.sessionId],
      isArchived: false,
    };
  }
  const backupDir = join(
    archiveDir,
    "backups",
    `codex-restored-${Date.now()}-${randomUUID()}`,
  );
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await writeFile(join(backupDir, "manifest.json"), manifestRaw, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(backupDir, "session-metadata.json"), metadataRaw, {
    flag: "wx",
    mode: 0o600,
  });
  const intentContent = JSON.stringify(
    {
      version: 1,
      records: [...records.values()],
      restoredPaths: verifiedPaths,
    },
    null,
    2,
  );
  await writeFile(join(backupDir, "migration.json"), intentContent, {
    flag: "wx",
    mode: 0o600,
  });
  // Check after hashing/backing up, before changing any live state. The intent
  // also makes a partial two-file update or a later legacy write recoverable.
  if (
    (await readFile(manifestPath, "utf8")) !== manifestRaw ||
    (await readFile(metadataPath, "utf8")) !== metadataRaw
  ) {
    throw new Error(
      "Yep state changed during migration; retry with the latest state",
    );
  }
  await atomicWrite(intentPath, intentContent);
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  await atomicWrite(metadataPath, JSON.stringify(metadata, null, 2));
  if (mode === "startup") await unlink(intentPath);
  return {
    sessionIds: [...records.keys()],
    backupDir,
    pending: mode === "stage",
  };
}
