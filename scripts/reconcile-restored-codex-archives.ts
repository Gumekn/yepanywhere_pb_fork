import { resolve } from "node:path";
import { reconcileRestoredCodexArchives } from "../packages/server/src/archive/codex-archive-migration.js";

// Explicit directory only: never infer a production data directory in tests.
const [dataDir, pathsFile, ...extra] = process.argv.slice(2);
if (!dataDir || extra.length) {
  throw new Error(
    "Usage: pnpm exec tsx scripts/reconcile-restored-codex-archives.ts <data-dir> [verified-restored-paths.json]",
  );
}
const restoredPaths = pathsFile
  ? JSON.parse(await readFile(pathsFile, "utf8"))
  : {};
if (
  !restoredPaths ||
  Array.isArray(restoredPaths) ||
  typeof restoredPaths !== "object" ||
  Object.values(restoredPaths).some((value) => typeof value !== "string")
) {
  throw new Error(
    "Restored paths must map original absolute paths to verified current absolute paths",
  );
}
console.log(
  JSON.stringify(
    await reconcileRestoredCodexArchives(
      resolve(dataDir),
      "stage",
      restoredPaths,
    ),
    null,
    2,
  ),
);
import { readFile } from "node:fs/promises";
