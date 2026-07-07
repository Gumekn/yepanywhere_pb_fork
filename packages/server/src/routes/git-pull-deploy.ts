import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  DeployRoutesOptions,
  DeploymentJob,
  DeploymentJobStatus,
} from "./deploy.js";

const execFileAsync = promisify(execFile);

/**
 * Helper function to execute git pull and build deployment
 */
export async function startGitPullAndDeploy(
  options: DeployRoutesOptions | undefined,
  repoRoot: string,
): Promise<DeploymentJob> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const dataDir =
    options?.dataDir ||
    path.join(require("node:os").homedir(), ".yep-anywhere");
  const logsDir = path.join(dataDir, "deploy-jobs", "logs");
  await fsp.mkdir(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `${id}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const job: DeploymentJob = {
    id,
    action: "git-pull-update",
    args: [],
    command: "git pull && pnpm build && restart",
    status: "running",
    startedAt: now,
    updatedAt: now,
  };

  // Run git pull + build + deploy asynchronously
  (async () => {
    try {
      logStream.write("==> Git Pull 更新开始\n");
      logStream.write(`时间: ${now}\n`);
      logStream.write(`仓库: ${repoRoot}\n\n`);

      // Step 1: Git pull
      logStream.write("==> 步骤 1/4: 执行 git pull\n");
      const { stdout: pullOutput, stderr: pullError } = await execFileAsync(
        "git",
        ["pull", "origin", "main"],
        { cwd: repoRoot, encoding: "utf-8", timeout: 60000 },
      );
      logStream.write(pullOutput);
      if (pullError) logStream.write(pullError);

      // Step 2: Install dependencies
      logStream.write("\n==> 步骤 2/4: 安装依赖 (pnpm install)\n");
      const { stdout: installOutput, stderr: installError } =
        await execFileAsync("pnpm", ["install"], {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 300000,
        });
      logStream.write(installOutput);
      if (installError) logStream.write(installError);

      // Step 3: Build project
      logStream.write("\n==> 步骤 3/4: 构建项目 (pnpm build)\n");
      const { stdout: buildOutput, stderr: buildError } = await execFileAsync(
        "pnpm",
        ["build"],
        { cwd: repoRoot, encoding: "utf-8", timeout: 300000 },
      );
      logStream.write(buildOutput);
      if (buildError) logStream.write(buildError);

      // Step 4: Restart service
      logStream.write("\n==> 步骤 4/4: 重启服务\n");
      const deployScript = path.join(repoRoot, "scripts", "deploy.sh");
      const { stdout: deployOutput, stderr: deployError } = await execFileAsync(
        deployScript,
        ["--server-only", "--restart-only"],
        { cwd: repoRoot, encoding: "utf-8", timeout: 120000 },
      );
      logStream.write(deployOutput);
      if (deployError) logStream.write(deployError);

      logStream.write("\n==> 更新完成!\n");
      job.status = "succeeded";
      job.exitCode = 0;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logStream.write(`\n==> 错误: ${errorMessage}\n`);
      job.status = "failed";
      job.exitCode = 1;
    } finally {
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      logStream.end();

      // Save job record
      const jobsDir = path.join(dataDir, "deploy-jobs");
      const jobRecordPath = path.join(jobsDir, `${id}.json`);
      await fsp.writeFile(jobRecordPath, JSON.stringify(job, null, 2));
    }
  })();

  return job;
}
