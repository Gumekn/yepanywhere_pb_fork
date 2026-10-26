import { useEffect, useState } from "react";
import {
  type ProjectBrowseEntry,
  type ProjectBrowseResponse,
  api,
} from "../api/client";
import { useI18n } from "../i18n";
import { FILE_ICONS_V2, FolderIconV2 } from "./FileTypeIcons";

function fileIconKey(entry: ProjectBrowseEntry): string {
  const name = entry.name.toLowerCase();
  if ([".gitignore", ".gitattributes"].includes(name)) return "git";
  if (name.startsWith(".env")) return "env";
  if (name === "dockerfile" || name.startsWith("docker-compose."))
    return "docker";
  if (name === "makefile" || name === "cmakelists.txt") return "build";
  if (name.startsWith("readme") || name.startsWith("changelog"))
    return "markdown";
  if (
    [
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
    ].includes(name)
  )
    return "package";
  if (["tsconfig.json", "jsconfig.json"].includes(name)) return "tsconfig";

  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  const FONT_EXT = "font";
  const groups: Record<string, readonly string[]> = {
    javascript: ["js", "mjs", "cjs"],
    typescript: ["ts"],
    jsx: ["jsx"],
    tsx: ["tsx"],
    python: ["py", "pyw", "ipy"],
    rust: ["rs"],
    go: ["go"],
    java: ["java", "jsp"],
    kotlin: ["kt", "kts"],
    cpp: ["c", "h", "cpp", "hpp", "cc", "cxx"],
    csharp: ["cs", "csx"],
    ruby: ["rb"],
    php: ["php"],
    swift: ["swift"],
    shell: ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"],
    html: ["html", "htm", "shtml"],
    css: ["css", "scss", "sass", "less"],
    vue: ["vue"],
    svelte: ["svelte"],
    json: ["json", "jsonc", "json5"],
    yaml: ["yaml", "yml"],
    xml: ["xml", "xsd", "xsl"],
    svg: ["svg"],
    config: ["toml", "ini", "cfg", "conf", "properties"],
    sql: ["sql"],
    graphql: ["graphql", "gql"],
    markdown: ["md", "mdx", "markdown", "rst", "adoc"],
    text: ["txt", "text", "log"],
    pdf: ["pdf"],
    word: ["doc", "docx", "rtf", "odt"],
    excel: ["xls", "xlsx", "ods", "csv", "tsv"],
    powerpoint: ["ppt", "pptx", "odp"],
    image: [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "bmp",
      "ico",
      "webp",
      "avif",
      "tiff",
      "tif",
      "psd",
      "heic",
      "heif",
    ],
    archive: ["zip", "tar", "gz", "rar", "7z", "bz2", "xz", "tgz"],
    binary: [
      "exe",
      "msi",
      "dll",
      "so",
      "dylib",
      "a",
      "o",
      "out",
      "bin",
      "app",
      "dmg",
      "deb",
      "rpm",
    ],
    [FONT_EXT]: ["ttf", "otf", "woff", "woff2", "eot"],
    audio: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "wma"],
    video: ["mp4", "webm", "mkv", "avi", "mov", "wmv", "flv", "m4v"],
    key: ["key", "pem", "crt", "cer", "pub"],
  };
  return (
    Object.entries(groups).find(([, extensions]) =>
      extensions.includes(extension),
    )?.[0] ?? "default"
  );
}

function FileIcon({ entry }: { entry: ProjectBrowseEntry }) {
  return (FILE_ICONS_V2[fileIconKey(entry)] ?? FILE_ICONS_V2.default)();
}

export function RepoTree({
  projectId,
  onOpenFile,
}: {
  projectId: string;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const [generation, setGeneration] = useState(0);

  return (
    <div className="repo-tree">
      <div className="repo-tree-toolbar">
        <button
          type="button"
          className="repo-tree-refresh"
          onClick={() => setGeneration((value) => value + 1)}
          aria-label={t("repoTreeRefresh")}
          title={t("repoTreeRefresh")}
        >
          ↻
        </button>
      </div>
      <DirectoryNode
        key={`${projectId}:${generation}`}
        projectId={projectId}
        path=""
        depth={0}
        onOpenFile={onOpenFile}
        root
      />
    </div>
  );
}

function DirectoryNode({
  projectId,
  path,
  depth,
  onOpenFile,
  root = false,
}: {
  projectId: string;
  path: string;
  depth: number;
  onOpenFile: (path: string) => void;
  root?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(root);
  const [data, setData] = useState<ProjectBrowseResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || data || error) return;
    let cancelled = false;
    api
      .browseProjectFiles(projectId, path)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [data, error, open, path, projectId]);

  const children = open ? (
    error ? (
      <div className="repo-tree-error">{t("repoTreeLoadFailed")}</div>
    ) : data ? (
      data.entries.length > 0 ? (
        <ul className="repo-tree-list">
          {data.entries.map((entry) => (
            <TreeEntry
              key={entry.path}
              entry={entry}
              projectId={projectId}
              depth={depth}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      ) : (
        <div className="repo-tree-empty">{t("repoTreeEmpty")}</div>
      )
    ) : (
      <div className="repo-tree-loading">{t("repoTreeLoading")}</div>
    )
  ) : null;

  if (root) return children;

  const name = path.split("/").pop() ?? path;
  return (
    <>
      <button
        type="button"
        className="repo-tree-item repo-tree-item--dir"
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={path}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="repo-tree-item-icon" aria-hidden="true">
          <FolderIconV2 isOpen={open} />
        </span>
        <span className="repo-tree-item-name">{name}</span>
      </button>
      {children}
    </>
  );
}

function TreeEntry({
  entry,
  projectId,
  depth,
  onOpenFile,
}: {
  entry: ProjectBrowseEntry;
  projectId: string;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  if (entry.type === "dir") {
    return (
      <li>
        <DirectoryNode
          projectId={projectId}
          path={entry.path}
          depth={depth + 1}
          onOpenFile={onOpenFile}
        />
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className="repo-tree-item"
        style={{ paddingLeft: 24 + depth * 16 }}
        onClick={() => onOpenFile(entry.path)}
        title={entry.path}
      >
        <span className="repo-tree-item-icon" aria-hidden="true">
          <FileIcon entry={entry} />
        </span>
        <span className="repo-tree-item-name">{entry.name}</span>
      </button>
    </li>
  );
}
