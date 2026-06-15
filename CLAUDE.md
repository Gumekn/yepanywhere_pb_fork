# Yep Anywhere

跨项目上下文（本项目与其他 Kyle 项目的关系）见 `~/code/dotfiles/projects/README.md`。

这是一个面向移动端优先的 Claude Code agent 监督器。它类似 VS Code 的 Claude 扩展，但专为手机和多会话工作流设计。

**核心思路：**
- **服务端持有进程**：Claude 在你的开发机上运行；客户端断开连接不会中断工作
- **多会话仪表盘**：一眼查看所有项目，不需要来回切换窗口
- **移动端监督**：审批通过推送通知到达，可从锁屏直接响应
- **零外部依赖**：不依赖 Firebase，不需要账号体系

**架构：** Hono 服务端管理 Claude SDK 进程。React 客户端通过 WebSocket 连接以接收实时流式输出。会话持久化为 jsonl 文件（由 SDK 处理）。

**远程访问：** 客户端直接连接服务端的 WebSocket。可以在你自己的网络中运行服务端，并通过 Tailscale、局域网 IP，或你控制的任意反向代理 / 隧道访问（例如带 TLS 的 Caddy）。可选的 Cookie 鉴权用于访问控制；见 `docs/project/remote-access.md`。

详细概览见 `docs/project/`。历史愿景文档在 `docs/archive/`。

## 端口配置

所有端口都从单个 `PORT` 环境变量派生（默认：3400）：

| 端口 | 用途 |
|------|------|
| PORT + 0 | 主服务端（默认：3400） |
| PORT + 1 | 维护服务端（默认：3401） |
| PORT + 2 | Vite dev server（默认：3402） |

使用不同端口运行：
```bash
PORT=4000 pnpm dev  # 使用 4000、4001、4002
```

单独覆盖（很少需要）：
- `MAINTENANCE_PORT`：覆盖维护端口（设为 0 可禁用）
- `VITE_PORT`：覆盖 Vite dev 端口

## 数据目录与 Profile

服务端状态存储在数据目录中（默认：`~/.yep-anywhere/`）。其中包括：
- `logs/`：服务端日志
- `indexes/`：会话索引缓存
- `uploads/`：上传文件
- `session-metadata.json`：自定义标题、归档/星标状态
- `notifications.json`：最后已读时间戳
- `push-subscriptions.json`：Web Push 订阅
- `vapid.json`：Push 使用的 VAPID key
- `auth.json`：鉴权状态（密码哈希、会话）

### 运行多个实例

使用 profile 同时运行开发和生产实例（类似 Chrome profile）：

```bash
# 生产环境（默认 profile，端口 3400）
PORT=3400 pnpm start

# 开发环境（dev profile，端口 4000）
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

这会创建独立的数据目录：
- 生产环境：`~/.yep-anywhere/`
- 开发环境：`~/.yep-anywhere-dev/`

环境变量：
- `YEP_ANYWHERE_PROFILE`：profile 名称后缀（创建 `~/.yep-anywhere-{profile}/`）
- `YEP_ANYWHERE_DATA_DIR`：数据目录的完整路径覆盖
- `CLAUDE_CONFIG_DIR`：Claude Code 配置目录（默认：`~/.claude`）。用它指向某个 Claude Code profile（例如 `~/.claude-work`）。会话会从 `{CLAUDE_CONFIG_DIR}/projects/` 扫描。

注意：默认情况下，所有实例共享 `~/.claude/projects/`（SDK 管理的会话）。如需每个实例使用不同的 Claude Code profile，请设置 `CLAUDE_CONFIG_DIR`。

## Provider 与功能配置

限制可用的 agent provider 和功能：

```bash
# 只显示 Claude Code（隐藏 Codex、Gemini 等）
ENABLED_PROVIDERS=claude pnpm dev

# 禁用语音输入（麦克风按钮）
VOICE_INPUT=false pnpm dev

# 组合示例：仅 Claude、无语音、dev profile
ENABLED_PROVIDERS=claude VOICE_INPUT=false PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

环境变量：
- `ENABLED_PROVIDERS`：要暴露的 provider 名称列表，逗号分隔（默认：全部）。有效名称：`claude`、`claude-ollama`、`codex`、`codex-oss`、`gemini`、`gemini-acp`、`opencode`
- `VOICE_INPUT`：设为 `false` 可在服务端禁用语音输入按钮（默认：`true`）

## Android 模拟器测试

当 Android 模拟器可用时，始终使用它测试。用 `source ~/.profile && adb devices` 检查，并在可能时部署/测试到模拟器。

## 浏览器控制（UI 测试）

使用 `~/code/claw-starter` 下的 claw-starter 浏览器技能自动化测试 Web UI。它基于 Playwright 和无头 Chromium。

**启动浏览器服务**（如果尚未运行）：

```bash
cd ~/code/claw-starter && npx tsx lib/browser/server.ts &
```

**CLI 命令**（从 `~/code/claw-starter` 运行）：

```bash
npx tsx lib/browser-cli.ts status              # 检查服务是否运行
npx tsx lib/browser-cli.ts open <url>           # 在新标签页打开 URL
npx tsx lib/browser-cli.ts navigate <url>       # 导航当前标签页
npx tsx lib/browser-cli.ts snapshot --efficient  # 读取页面（accessibility tree）
npx tsx lib/browser-cli.ts screenshot           # 截图（返回路径）
npx tsx lib/browser-cli.ts click e5             # 按 ref 点击元素
npx tsx lib/browser-cli.ts type e5 "text"       # 向元素输入文本
npx tsx lib/browser-cli.ts evaluate "JS expr"   # 执行 JS 并返回结果
npx tsx lib/browser-cli.ts tabs                 # 列出打开的标签页
npx tsx lib/browser-cli.ts close                # 关闭标签页
```

**工作流**：snapshot -> act（按元素 ref click/type）-> 再次 snapshot 验证。

完整 CLI 参考见 `~/code/claw-starter/README.md`。

## 验证流程的自主边界

除非用户明确要求，或当前任务无法在没有这些步骤的情况下完成，否则不要自动进入后续 UI 验证、本地部署或额外 dev server 启动。前端展示类工作尤其如此：完成代码改动，并只运行完成该编辑所需的聚焦、非侵入式检查。启动额外浏览器会话、部署/重新部署服务，或启用备用端口之前，需要先询问用户。

## ChromeOS 调试

对于 Chromebook 测试和调试（截图、输入、诊断），使用 chromeos-testbed CLI，不要使用浏览器控制技能（后者用于本地无头 Chromium）。

```bash
~/code/chromeos-testbed/bin/chromeos screenshot              # 保存截图并打印路径
~/code/chromeos-testbed/bin/chromeos screenshot output.png   # 保存到 output.png
~/code/chromeos-testbed/bin/chromeos help                    # 完整命令列表
```

需要能 SSH 到 `chromeroot`。详情见 `~/code/chromeos-testbed/CLAUDE.md`。

## 编辑代码后

编辑 TypeScript 或其他源码文件后，验证改动可以编译并通过检查：

```bash
pnpm lint       # Biome linter
pnpm typecheck  # TypeScript 类型检查（快，无 emit）
pnpm test       # 单元测试
pnpm test:e2e   # E2E 测试（如果涉及 UI 改动）
```

对于站点改动（`site/` 中的营销页面）：
```bash
cd site && npm run build   # Astro check + build（或从根目录运行：pnpm site:build）
```

在认为任务完成前，先修复所有错误。

## 依赖安全维护

定期运行 `pnpm audit --prod`，特别关注 `web-push -> asn1.js -> bn.js` 链路。在 `web-push` 发布上游修复前，保持 `bn.js` 已打补丁（当前通过 pnpm override）。

## Git 提交

提交信息中不要提及 Claude、AI 或任何 AI assistant。像人类开发者一样撰写提交信息。

## 发布到 npm

该包通过 GitHub Actions 和 OIDC trusted publishing 发布到 npm，包名为 `yepanywhere`（不在 secrets 中存储 npm token）。

**发布前：**

1. 在 `CHANGELOG.md` 中新增版本章节：
   ```markdown
   ## [0.1.11] - 2025-01-24

   ### Added
   - New feature description

   ### Fixed
   - Bug fix description
   ```

2. 提交 changelog 更新

3. 打 tag 并推送：
   ```bash
   git tag v0.1.11
   git push origin v0.1.11
   ```

CI workflow 会验证 changelog 包含待发布版本的条目。如果缺失，发布会失败并提示更新 changelog。

workflow 会运行 lint、typecheck 和 tests，然后通过 `pnpm build:bundle` 构建，并使用 `--provenance` 发布以提供供应链证明。它还会创建带自动生成说明的 GitHub Release。

## 发布网站

网站（营销落地页）与 npm 包分开部署到 GitHub Pages。**推送到 main 不会部署网站**，只会运行 CI（lint、typecheck、tests）。网站只会在推送 `site-v*` tag 时部署（或通过手动 workflow_dispatch）。

完整流程见 `site/RELEASING.md`。

快速参考：
```bash
# 先更新 site/CHANGELOG.md，然后：
scripts/release-website.sh 1.5.3
```

## 服务端日志

服务端日志写入 `{dataDir}/logs/`（默认：`~/.yep-anywhere/logs/`）：

- `server.log`：主服务端日志（`pnpm dev` 开发模式）
- `e2e-server.log`：E2E 测试期间的服务端日志

实时查看日志：`tail -f ~/.yep-anywhere/logs/server.log`

所有 `console.log/error/warn` 输出都会被捕获。文件中的日志是 JSON 格式，但控制台会 pretty-print。

环境变量：
- `LOG_DIR`：自定义日志目录
- `LOG_FILE`：自定义日志文件名（默认：server.log）

## 本地部署记忆

`~/.zshrc` 中历史 shell alias 如下：

```bash
alias yep-deploy='/Users/yueyuan/Desktop/work/before_work/yepanywhere/scripts/redeploy-server.sh && /Users/yueyuan/Desktop/work/before_work/yepanywhere/scripts/rebuild-apk.sh'
alias yep-server='/Users/yueyuan/Desktop/work/before_work/yepanywhere/scripts/redeploy-server.sh'
```

新的工作优先使用统一项目入口：

```bash
scripts/deploy.sh                 # 服务端 rebuild/restart/verify，然后构建/安装 APK
scripts/deploy.sh --server-only   # 仅服务端
scripts/deploy.sh --apk-only      # 仅 APK
pnpm deploy -- --server-only      # 通过 package.json 使用同一入口
```

`scripts/redeploy-server.sh` 现在会在重启后执行强部署验证。它会比较运行中服务端的 `/api/version` `build.buildId`、已服务的前端 `/build-info.json`，以及 `dist/npm-package/build-info.json`。如果验证失败，说明响应 8022 的进程或静态前端 bundle 不是刚构建的代码。调试应用行为前，先检查 `/tmp/yep-server.log` 和 `~/.yep-anywhere/logs/server.log`。

处理 Codex 编辑消息/session branch 问题时，先检查服务端日志中的：

- `session_resume_requested`：API 收到了 provider、`resumeSessionAt` 和 `rollbackNumTurns`。
- `session_rewind_existing_process_restart`：Supervisor 终止了现有进程，使 rewind 参数能生效，而不是排队为普通下一轮。
- `provider_session_start_requested`：provider 启动选项包含 rewind 字段。
- `codex_thread_rollback_requested` 和 `codex_thread_rollback_completed`：确实调用了 Codex app-server 的 `thread/rollback`。

如果 Codex JSONL 中没有 `thread_rolled_back` 事件且这些日志缺失，说明 client/server 路径没有提交 rollback。如果这些日志存在但 JSONL 没有 marker，需要调查 Codex app-server 响应路径。
- `LOG_LEVEL`：最低级别：fatal、error、warn、info、debug、trace（默认：info）
- `LOG_FILE_LEVEL`：文件日志的独立级别（默认：与 LOG_LEVEL 相同）
- `LOG_TO_FILE`：设为 `"true"` 可启用文件日志（默认：关闭）
- `LOG_PRETTY`：设为 `"false"` 可禁用控制台 pretty logs（默认：开启）

## 客户端控制台日志

远程收集移动客户端浏览器的 `console.log/warn/error`。这对调试无法打开 DevTools 的设备上的连接问题很有用。

**启用：** Developer Mode settings -> "Remote Log Collection" toggle。

**存储：** `{dataDir}/logs/client-logs/`（默认：`~/.yep-anywhere/logs/client-logs/`）。每天每个设备一个 JSONL 文件，命名为 `client-{YYYY-MM-DD}-{deviceId}.jsonl`。设备 UUID 会持久化到客户端的 `localStorage`。

每一行都是一个日志事件：
```json
{"timestamp":1770790157738,"level":"log","prefix":"[SecureConnection]","message":"[SecureConnection] Closed: 1006","_receivedAt":1770790161477}
```

每次会话启动时会写入一个 `[ClientInfo]` 条目，包含 user agent、屏幕尺寸、DPR 和语言。

```bash
# 列出设备日志文件
ls ~/.yep-anywhere/logs/client-logs/

# 查看某个设备今天的日志
cat ~/.yep-anywhere/logs/client-logs/client-$(date +%Y-%m-%d)-<deviceId>.jsonl

# 跟随新增日志
tail -f ~/.yep-anywhere/logs/client-logs/*.jsonl
```

**实现：** `packages/client/src/lib/diagnostics/ClientLogCollector.ts`（客户端），`packages/server/src/routes/client-logs.ts`（服务端 `POST /api/client-logs`）。

## 维护服务端

一个单独的轻量 HTTP 服务运行在 PORT + 1（默认 3401），用于带外诊断。当主服务无响应时很有用。

```bash
# 检查服务状态
curl http://localhost:3401/status

# 运行时启用 proxy debug logging
curl -X PUT http://localhost:3401/proxy/debug -d '{"enabled": true}'

# 运行时修改日志级别
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'

# 启用 Chrome DevTools inspector
curl -X POST http://localhost:3401/inspector/open
# 然后在 Chrome 中打开 chrome://inspect

# 触发服务端重启
curl -X POST http://localhost:3401/reload
```

可用 endpoints：
- `GET /health`：健康检查
- `GET /status`：内存、uptime、连接
- `GET|PUT /log/level`：获取/设置日志级别
- `GET|PUT /proxy/debug`：获取/设置 proxy debug logging
- `GET /inspector`：Inspector 状态
- `POST /inspector/open`：启用 Chrome DevTools
- `POST /inspector/close`：禁用 Chrome DevTools
- `POST /reload`：重启服务端

环境变量：
- `MAINTENANCE_PORT`：维护服务端端口（默认：PORT + 1，设为 0 可禁用）
- `PROXY_DEBUG`：启动时启用 proxy debug logging（默认：false）

## 校验会话数据

用 Zod schema 校验 JSONL 会话文件：

```bash
# 校验 ~/.claude/projects 中的所有会话
npx tsx scripts/validate-jsonl.ts

# 校验指定文件或目录
npx tsx scripts/validate-jsonl.ts /path/to/session.jsonl
```

schema 变更后运行它，以验证与现有会话数据的兼容性。

## 校验工具结果

用 ToolResultSchemas 校验 SDK 原始日志中的 `tool_use_result` 字段：

```bash
# 校验 sdk-raw.jsonl（默认位置）
npx tsx scripts/validate-tool-results.ts

# 只输出摘要（无错误详情）
npx tsx scripts/validate-tool-results.ts --summary

# 按工具名过滤
npx tsx scripts/validate-tool-results.ts --tool=Edit
```

SDK 会在工具结果旁提供结构化 `tool_use_result` 对象。当设置 `LOG_SDK_MESSAGES=true` 时，这些对象会记录到 `~/.yep-anywhere/logs/sdk-raw.jsonl`。添加新工具 schema 后，或调试工具结果解析时，运行此脚本。

## 类型系统

类型定义在 `packages/shared/src/claude-sdk-schema/` 中（以 Zod schema 作为事实来源）。

关键模式：
- **消息识别**：使用 `getMessageId(m)` helper，它返回 `uuid ?? id`
- **内容访问**：优先使用 `message.content`，而不是顶层 `content`
- **类型判别**：使用 `type` 字段（user/assistant/system/summary）
