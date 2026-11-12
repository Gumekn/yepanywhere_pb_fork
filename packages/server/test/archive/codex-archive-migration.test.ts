import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileRestoredCodexArchives } from "../../src/archive/codex-archive-migration.js";

describe("restored Codex archive migration", () => {
  let dir: string;
  let source: string;
  let archive: string;
  let manifestPath: string;
  let metadataPath: string;
  let manifestRaw: string;
  let metadataRaw: string;
  const content = '{"type":"session_meta","payload":{"id":"codex-1"}}\n';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-archive-migration-"));
    await mkdir(join(dir, "archive"));
    source = join(dir, "rollout.jsonl");
    archive = join(dir, "archive", "rollout.jsonl");
    manifestPath = join(dir, "archive", "manifest.json");
    metadataPath = join(dir, "session-metadata.json");
    await writeFile(source, content);
    await writeFile(archive, content);
    manifestRaw = JSON.stringify({
      version: 1,
      sessions: {
        "codex-1": {
          sessionId: "codex-1",
          provider: "codex",
          archivedAt: "2026-11-03",
          reason: "auto",
          files: [
            {
              originalPath: source,
              archivePath: archive,
              size: content.length,
              mtimeMs: 0,
              kind: "session",
            },
          ],
        },
        "claude-1": { sessionId: "claude-1", provider: "claude", files: [] },
      },
    });
    metadataRaw = JSON.stringify({
      version: 2,
      sessionIdAliases: { old: "codex-1" },
      sessions: {
        "codex-1": {
          isArchived: true,
          isStarred: true,
          customTitle: "Keep title",
        },
        "claude-1": { isArchived: true },
      },
    });
    await writeFile(manifestPath, manifestRaw);
    await writeFile(metadataPath, metadataRaw);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("backs up state, clears only restored Codex flags, and replays legacy writes once", async () => {
    const before = await stat(source);
    const result = await reconcileRestoredCodexArchives(dir, "stage");
    expect(result.sessionIds).toEqual(["codex-1"]);
    expect(result.pending).toBe(true);
    if (!result.backupDir) throw new Error("Missing backup");
    expect(
      await readFile(join(result.backupDir, "manifest.json"), "utf8"),
    ).toBe(manifestRaw);
    expect(
      await readFile(join(result.backupDir, "session-metadata.json"), "utf8"),
    ).toBe(metadataRaw);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).sessions).toEqual({
      "claude-1": JSON.parse(manifestRaw).sessions["claude-1"],
    });
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata.sessions["codex-1"]).toEqual({
      isArchived: false,
      isStarred: true,
      customTitle: "Keep title",
    });
    expect(metadata.sessionIdAliases).toEqual({ old: "codex-1" });
    expect(await readFile(archive, "utf8")).toBe(content);
    expect((await stat(source)).mtimeMs).toBe(before.mtimeMs);

    // Old in-memory services can write their previous state until deployment.
    await writeFile(manifestPath, manifestRaw);
    await writeFile(metadataPath, metadataRaw);
    await writeFile(source, `${content}{"type":"new_message"}\n`);
    const replay = await reconcileRestoredCodexArchives(dir, "startup");
    expect(replay.pending).toBe(false);
    expect(
      JSON.parse(await readFile(metadataPath, "utf8")).sessions["codex-1"]
        .isArchived,
    ).toBe(false);
    expect(await readFile(source, "utf8")).toContain("new_message");
    expect(await readFile(archive, "utf8")).toBe(content);
    // Later intentional metadata archives must survive subsequent startups.
    await writeFile(metadataPath, metadataRaw);
    expect(
      (await reconcileRestoredCodexArchives(dir, "startup")).sessionIds,
    ).toEqual([]);
    expect(await readFile(metadataPath, "utf8")).toBe(metadataRaw);
  });

  it.each(["missing", "different"])(
    "refuses %s source files without changing state",
    async (kind) => {
      if (kind === "missing") await rm(source);
      else await writeFile(source, "different history");
      await expect(
        reconcileRestoredCodexArchives(dir, "stage"),
      ).rejects.toThrow();
      expect(await readFile(manifestPath, "utf8")).toBe(manifestRaw);
      expect(await readFile(metadataPath, "utf8")).toBe(metadataRaw);
      expect(await readFile(archive, "utf8")).toBe(content);
    },
  );

  it("keeps the pending intent when a restored file conflicts before startup", async () => {
    await reconcileRestoredCodexArchives(dir, "stage");
    await writeFile(source, "replaced history");
    await expect(
      reconcileRestoredCodexArchives(dir, "startup"),
    ).rejects.toThrow();
    expect(
      await stat(join(dir, "archive", "codex-restored-migration.pending.json")),
    ).toBeDefined();
  });

  it("accepts appended history and an explicitly verified native archive path without moving it", async () => {
    const nativeArchivePath = join(dir, "native-archive.jsonl");
    await writeFile(nativeArchivePath, `${content}{"type":"new_message"}\n`);
    await rm(source);
    const paths = { [source]: nativeArchivePath };
    const result = await reconcileRestoredCodexArchives(dir, "stage", paths);
    expect(result.sessionIds).toEqual(["codex-1"]);
    await reconcileRestoredCodexArchives(dir, "startup");
    expect(await readFile(nativeArchivePath, "utf8")).toBe(
      `${content}{"type":"new_message"}\n`,
    );
    expect(await readFile(archive, "utf8")).toBe(content);
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
