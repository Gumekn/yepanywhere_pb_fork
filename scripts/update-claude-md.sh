#!/bin/bash

# CLAUDE.md 自动更新脚本
# 此脚本会备份原文件，然后应用所有建议的修改

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
BACKUP_FILE="$CLAUDE_MD.backup.$(date +%Y%m%d_%H%M%S)"

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}CLAUDE.md 自动更新脚本${NC}"
echo ""

# 检查文件是否存在
if [ ! -f "$CLAUDE_MD" ]; then
    echo -e "${RED}错误：找不到 CLAUDE.md 文件${NC}"
    exit 1
fi

# 备份原文件
echo -e "${YELLOW}备份原文件到：${NC}$BACKUP_FILE"
cp "$CLAUDE_MD" "$BACKUP_FILE"

echo -e "${GREEN}开始应用修改...${NC}"
echo ""

# 修改 1: 删除第 3 行（外部引用）
echo "1. 删除外部项目引用（第 3 行）..."
sed -i '' '3d' "$CLAUDE_MD"

# 修改 2: 更新端口配置章节
echo "2. 更新端口配置章节..."
# 这个修改比较复杂，需要精确匹配和替换
perl -i -pe 'BEGIN{undef $/;} s/## 端口配置\n\n所有端口都从单个 `PORT` 环境变量派生（默认：3400）：/## 端口配置\n\n### 开发模式（pnpm dev）\n\n所有端口都从单个 `PORT` 环境变量派生（默认：3400）：/smg' "$CLAUDE_MD"

# 在 VITE_PORT 说明后添加生产模式说明
perl -i -pe 'BEGIN{undef $/;} s/(- `VITE_PORT`：覆盖 Vite dev 端口)\n\n(## 数据目录与 Profile)/$1\n\n### 生产模式（LaunchAgent）\n\n生产部署默认使用端口 8022（通过 `YEP_DEPLOY_PORT` 环境变量控制）：\n\n```bash\n# 修改生产端口\nYEP_DEPLOY_PORT=3400 scripts\/install-launchagents.sh\n```\n\n**说明**：开发模式（3400）和生产模式（8022）使用不同的默认端口是设计行为，避免两者同时运行时冲突。\n\n$2/smg' "$CLAUDE_MD"

# 修改 3: 更新浏览器控制章节
echo "3. 更新浏览器控制章节..."
perl -i -pe 's/## 浏览器控制（UI 测试）\n\n使用 `~\/code\/claw-starter`/## 浏览器控制（UI 测试）\n\n**注意**：此功能依赖外部项目 `claw-starter`，需要单独安装。如果该项目不存在，此功能不可用，但不影响核心功能。\n\n使用 `~\/code\/claw-starter`/g' "$CLAUDE_MD"

# 修改 4: 更新 ChromeOS 调试章节
echo "4. 更新 ChromeOS 调试章节..."
perl -i -pe 's/## ChromeOS 调试\n\n对于 Chromebook/## ChromeOS 调试\n\n**注意**：此功能依赖外部项目 `chromeos-testbed`，需要单独安装。如果该项目不存在，此功能不可用，但不影响核心功能。\n\n对于 Chromebook/g' "$CLAUDE_MD"

# 修改 5: 更新"本地部署记忆"章节标题和内容
echo "5. 更新本地部署章节..."
perl -i -pe 's/## 本地部署记忆/## 本地部署/g' "$CLAUDE_MD"

# 删除旧的 alias 部分，替换为新说明
perl -i -0777 -pe 's/`~\/\.zshrc` 中历史 shell alias 如下：\n\n```bash\nalias yep-deploy=.*?\nalias yep-server=.*?\n```\n\n新的工作优先使用统一项目入口：/**本地别名配置**：每个用户的环境可能不同，具体别名配置请参考 `docs\/project\/local-setup-pbzhang.md`（或创建自己的本地配置文档）。\n\n使用统一的部署脚本：\n/sg' "$CLAUDE_MD"

# 修改 6: 更新服务端日志章节
echo "6. 更新服务端日志章节..."
perl -i -0777 -pe 's/## 服务端日志\n.*?(?=\n## |\z)/## 服务端日志\n\n服务端应用日志路径会在启动时打印为 `[Config] Log file: ...`，默认位于 `{dataDir}\/logs\/`（默认：`~\/.yep-anywhere\/logs\/`）：\n\n- `server.log`：开发模式日志（`pnpm dev`）\n- `e2e-server.log`：E2E 测试期间的服务端日志\n- `server-launchd.out.log`：LaunchAgent 标准输出日志\n- `server-launchd.err.log`：LaunchAgent 错误输出日志\n\n**开发模式日志**：\n```bash\ntail -f ~\/.yep-anywhere\/logs\/server.log\n```\n\n**生产模式日志**（LaunchAgent）：\n```bash\ntail -f ~\/.yep-anywhere\/logs\/server-launchd.out.log\ntail -f ~\/.yep-anywhere\/logs\/server-launchd.err.log\n```\n\n**开发后台控制台日志**：\n```bash\ntail -f ~\/.yep-anywhere\/logs\/dev-console.log\n```\n\n所有 `console.log\/error\/warn` 输出都会被捕获。应用日志文件通常是 JSON 格式；stdout\/stderr 日志会 pretty-print。\n/s' "$CLAUDE_MD"

# 修改 7: 更新部署验证说明
echo "7. 更新部署验证说明..."
perl -i -pe 's/说明响应 8022 的进程或静态前端 bundle 不是刚构建的代码。调试应用行为前，先检查 `\/tmp\/yep-server\.log` 和 `~\/\.yep-anywhere\/logs\/server\.log`。/说明响应端口的进程或静态前端 bundle 不是刚构建的代码。调试应用行为前，先检查服务端日志（开发模式：`~\/.yep-anywhere\/logs\/server.log`，生产模式：`~\/.yep-anywhere\/logs\/server-launchd.*.log`）。/g' "$CLAUDE_MD"

echo ""
echo -e "${GREEN}✓ 所有修改已应用${NC}"
echo ""
echo -e "${CYAN}验证修改：${NC}"
echo "  查看修改后的文件: cat CLAUDE.md | head -50"
echo "  对比差异: diff $BACKUP_FILE CLAUDE.md"
echo "  恢复备份: mv $BACKUP_FILE CLAUDE.md"
echo ""
echo -e "${YELLOW}提示：如果修改有问题，可以从备份文件恢复${NC}"
