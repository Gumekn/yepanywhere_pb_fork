# 本地环境配置说明

本文档记录当前用户（pbzhang）的本地配置，作为 CLAUDE.md 的补充说明。

## 环境信息

- **用户名**: `pbzhang`
- **项目路径**: `/Users/pbzhang/Desktop/代码/yepanywhere_pb_fork/`
- **数据目录**: `~/.yep-anywhere/`
- **Claude 配置**: `~/.claude/`

## 端口配置

### 开发模式（pnpm dev）

默认端口：**3400**（可通过 `PORT` 环境变量修改）

```bash
PORT=3400 pnpm dev  # 主服务端: 3400, 维护: 3401, Vite: 3402
```

| 端口 | 用途 |
|------|------|
| 3400 | 主服务端 |
| 3401 | 维护服务端 |
| 3402 | Vite dev server |

### 生产模式（LaunchAgent）

默认端口：**8022**（可通过 `YEP_DEPLOY_PORT` 环境变量修改）

```bash
# 通过环境变量修改生产端口
YEP_DEPLOY_PORT=3400 scripts/install-launchagents.sh
```

**说明**：开发模式和生产模式使用不同的默认端口是设计行为，避免冲突。

## 本地别名配置

在 `~/.zshrc` 中配置的别名：

```bash
# 启动/停止脚本
alias yepanywhere="/Users/pbzhang/.local/bin/start-yepanywhere.sh"
alias stop-yepanywhere="/Users/pbzhang/.local/bin/stop-yepanywhere.sh"

# LaunchAgent 服务管理
alias yep-start='launchctl load ~/Library/LaunchAgents/com.yueyuan.yepanywhere.server.plist'
alias yep-stop='launchctl unload ~/Library/LaunchAgents/com.yueyuan.yepanywhere.server.plist'
alias yep-restart='launchctl kickstart -k gui/$(id -u)/com.yueyuan.yepanywhere.server'
```

### 别名说明

- `yepanywhere`: 启动 LaunchAgent 服务（检查状态、加载服务）
- `stop-yepanywhere`: 停止 LaunchAgent 服务（清理进程、释放端口）
- `yep-start`: 直接加载 LaunchAgent plist
- `yep-stop`: 直接卸载 LaunchAgent plist
- `yep-restart`: 重启 LaunchAgent 服务

## LaunchAgent 配置

### 已安装的 LaunchAgent

```
~/Library/LaunchAgents/com.yueyuan.yepanywhere.server.plist
```

**注意**：Label 名称为 `com.yueyuan.yepanywhere.server` 是历史原因（fork 自原作者项目）。可以通过环境变量自定义：

```bash
# 自定义 LaunchAgent label
export YEP_LAUNCHD_SERVER_LABEL="com.pbzhang.yepanywhere.server"
scripts/install-launchagents.sh
```

### LaunchAgent 配置详情

- **工作目录**: `/Users/pbzhang/Desktop/代码/yepanywhere_pb_fork/`
- **端口**: 8022（可通过 `YEP_DEPLOY_PORT` 修改）
- **日志位置**:
  - 标准输出: `~/.yep-anywhere/logs/server-launchd.out.log`
  - 错误输出: `~/.yep-anywhere/logs/server-launchd.err.log`

## 日志文件位置

### 开发模式日志

```bash
# 服务端应用日志
~/.yep-anywhere/logs/server.log

# 后台运行时的控制台日志
~/.yep-anywhere/logs/dev-console.log
```

### 生产模式日志

```bash
# LaunchAgent 日志（推荐）
~/.yep-anywhere/logs/server-launchd.out.log
~/.yep-anywhere/logs/server-launchd.err.log

# 后台运行日志（使用 yep.sh 脚本时）
/private/tmp/yep-server.log
```

### 客户端日志（可选）

启用 Developer Mode -> "Remote Log Collection" 后：

```bash
~/.yep-anywhere/logs/client-logs/client-{YYYY-MM-DD}-{deviceId}.jsonl
```

## 启动方式对比

### 方式 1：pnpm 命令（推荐用于开发）

```bash
# 开发模式（前台运行，热重载）
pnpm dev

# 生产模式（前台运行）
pnpm start

# 指定端口
PORT=3400 pnpm dev
PORT=3400 pnpm start
```

### 方式 2：yep.sh 脚本（推荐用于本地测试）

```bash
# 交互式菜单
bash yep.sh

# 或使用命令
bash yep.sh start-dev    # 启动开发模式（可选前台/后台）
bash yep.sh start-prod   # 启动生产模式（可选前台/后台）
bash yep.sh stop         # 停止所有服务
bash yep.sh status       # 查看服务状态
```

### 方式 3：LaunchAgent（推荐用于持久运行）

```bash
# 安装 LaunchAgent（开机自启）
pnpm launchd:install
# 或
scripts/install-launchagents.sh

# 启动服务
yep-start
# 或
yepanywhere

# 停止服务
yep-stop
# 或
stop-yepanywhere

# 重启服务
yep-restart
```

### 方式 4：部署脚本（推荐用于完整部署）

```bash
# 完整部署：服务端 + APK
scripts/deploy.sh

# 仅服务端
scripts/deploy.sh --server-only
pnpm deploy -- --server-only

# 仅 APK
scripts/deploy.sh --apk-only
```

## 项目管理命令

### 构建

```bash
pnpm build              # 构建所有包
pnpm build:bundle       # 构建 npm 发布包
pnpm build:stable       # 构建稳定版客户端
```

### 验证

```bash
pnpm lint               # Biome linter
pnpm typecheck          # TypeScript 类型检查
pnpm test               # 单元测试
pnpm test:e2e           # E2E 测试
```

### 部署

```bash
pnpm deploy             # 完整部署
pnpm launchd:install    # 安装 LaunchAgent
pnpm launchd:uninstall  # 卸载 LaunchAgent
```

## 外部工具（可选）

CLAUDE.md 中提到的一些外部工具在当前环境中不存在，如需使用需单独安装：

### 浏览器控制（UI 测试）

```bash
# 需要安装 claw-starter 项目
# git clone <repo> ~/code/claw-starter
# cd ~/code/claw-starter && npm install
```

### ChromeOS 调试

```bash
# 需要安装 chromeos-testbed 项目
# git clone <repo> ~/code/chromeos-testbed
```

这些工具是可选的，不影响核心功能。

## 环境变量参考

### 端口配置

```bash
PORT=3400                          # 主端口（开发模式）
YEP_DEPLOY_PORT=8022              # 主端口（生产模式）
MAINTENANCE_PORT=3401             # 维护服务端口
VITE_PORT=3402                    # Vite dev server 端口
YEP_CODEX_BRIDGE_PORT=4510        # Codex bridge 端口
YEP_CLAUDE_BRIDGE_PORT=4520       # Claude bridge 端口
```

### LaunchAgent 配置

```bash
YEP_LAUNCHD_SERVER_LABEL=com.pbzhang.yepanywhere.server
YEP_LAUNCHD_BRIDGE_LABEL=com.pbzhang.yepanywhere.codex-bridge
YEP_LAUNCHD_CLAUDE_BRIDGE_LABEL=com.pbzhang.yepanywhere.claude-bridge
YEP_LAUNCHD_NODE=/path/to/node    # Node 二进制路径
YEP_LAUNCHD_LOG_DIR=~/.yep-anywhere/logs
```

### Profile 配置

```bash
YEP_ANYWHERE_PROFILE=dev          # Profile 名称（创建独立数据目录）
YEP_ANYWHERE_DATA_DIR=/custom/path # 数据目录完整路径
CLAUDE_CONFIG_DIR=~/.claude       # Claude Code 配置目录
```

### Provider 配置

```bash
ENABLED_PROVIDERS=claude          # 限制可用的 provider
VOICE_INPUT=false                 # 禁用语音输入
```

### 日志配置

```bash
LOG_DIR=/custom/log/dir           # 自定义日志目录
LOG_FILE=server.log               # 日志文件名
LOG_LEVEL=info                    # 日志级别
LOG_TO_FILE=true                  # 启用文件日志
LOG_PRETTY=true                   # Pretty print 日志
PROXY_DEBUG=true                  # Proxy debug logging
```

## 故障排查

### 检查服务状态

```bash
# 使用 yep.sh
bash yep.sh status

# 手动检查端口
lsof -i :3400
lsof -i :8022

# 检查 LaunchAgent
launchctl list | grep yepanywhere
```

### 查看日志

```bash
# 开发模式
tail -f ~/.yep-anywhere/logs/server.log

# 生产模式（LaunchAgent）
tail -f ~/.yep-anywhere/logs/server-launchd.out.log
tail -f ~/.yep-anywhere/logs/server-launchd.err.log

# 后台运行
tail -f /private/tmp/yep-server.log
```

### 重启服务

```bash
# 方式 1：使用别名
yep-restart

# 方式 2：使用脚本
bash yep.sh restart-prod

# 方式 3：手动重启
stop-yepanywhere
yepanywhere
```

### 清理并重新安装

```bash
# 卸载 LaunchAgent
pnpm launchd:uninstall

# 停止所有服务
bash yep.sh stop

# 重新构建
pnpm build:bundle

# 重新安装 LaunchAgent
pnpm launchd:install
```

## CLAUDE.md 中过时的内容

以下是 CLAUDE.md 中的一些过时内容，以本文档为准：

1. **别名记录**（CLAUDE.md 第 226-231 行）：记录的 `yep-deploy` 和 `yep-server` 别名不存在，实际别名见本文档"本地别名配置"章节。

2. **日志路径**（CLAUDE.md 第 214 行）：提到 `/private/tmp/yep-server.log` 是 LaunchAgent 日志，实际 LaunchAgent 日志位于 `~/.yep-anywhere/logs/server-launchd.*.log`。

3. **外部工具路径**：CLAUDE.md 引用的 `~/code/claw-starter` 和 `~/code/chromeos-testbed` 在当前环境中不存在，这些是可选工具。

4. **示例路径**：CLAUDE.md 中的示例路径 `/Users/yueyuan/` 来自原作者环境，当前环境为 `/Users/pbzhang/`。
