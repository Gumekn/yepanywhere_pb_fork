import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface GitUpdateResult {
  success: boolean;
  message: string;
  changes?: string;
  currentBranch?: string;
  beforeCommit?: string;
  afterCommit?: string;
}

/**
 * Execute git pull to update the repository
 */
export async function gitPullUpdate(
  repoRoot: string,
): Promise<GitUpdateResult> {
  try {
    // 1. Get current branch
    const { stdout: branchOutput } = await execAsync(
      "git rev-parse --abbrev-ref HEAD",
      { cwd: repoRoot, encoding: "utf-8" },
    );
    const currentBranch = branchOutput.trim();

    // 2. Get current commit hash
    const { stdout: beforeCommit } = await execAsync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const beforeHash = beforeCommit.trim();

    // 3. Check for uncommitted changes
    const { stdout: statusOutput } = await execAsync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    if (statusOutput.trim()) {
      return {
        success: false,
        message: "有未提交的修改，无法执行 git pull。请先提交或暂存修改。",
        currentBranch,
      };
    }

    // 4. Execute git pull
    const { stdout: pullOutput } = await execAsync("git pull origin main", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 60000, // 60 seconds timeout
    });

    // 5. Get new commit hash
    const { stdout: afterCommit } = await execAsync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const afterHash = afterCommit.trim();

    // 6. Check if there were any changes
    if (beforeHash === afterHash) {
      return {
        success: true,
        message: "已是最新版本，无需更新",
        currentBranch,
        beforeCommit: beforeHash,
        afterCommit: afterHash,
      };
    }

    // 7. Get changes summary
    const { stdout: changesOutput } = await execAsync(
      `git log --oneline ${beforeHash}..${afterHash}`,
      { cwd: repoRoot, encoding: "utf-8" },
    );

    return {
      success: true,
      message: "代码更新成功",
      changes: changesOutput.trim(),
      currentBranch,
      beforeCommit: beforeHash,
      afterCommit: afterHash,
    };
  } catch (error) {
    return {
      success: false,
      message: `Git pull 失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
