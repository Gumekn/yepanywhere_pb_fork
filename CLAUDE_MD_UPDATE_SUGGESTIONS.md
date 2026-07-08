# CLAUDE.md 更新建议

## 需要更新的章节

### 1. "生产模式（Bundle 独立部署包）" 章节（第 77-94 行）

**当前内容：**
```markdown
### 生产模式（Bundle 独立部署包）

**默认端口：8022**

生产模式运行打包后的独立 Bundle：

```bash
# 启动生产模式
node dist/npm-package/dist/cli.js --port 8022

# 或使用 yep.sh
bash yep.sh start-prod

# 修改 LaunchAgent 部署端口
YEP_DEPLOY_PORT=9000 scripts/install-launchagents.sh
```

**说明**：开发模式（3400）和生产模式（8022）使用不同的默认端口，两种模式可以同时运行互不冲突。
```

**建议修改为：**
```markdown
### 生产模式（Bundle 独立部署包）

**默认端口：8022**（当 `NODE_ENV=production` 时）

生产模式运行打包后的独立 Bundle：

```bash
# 启动生产模式（推荐：设置 NODE_ENV=production）
NODE_ENV=production node dist/npm-package/dist/cli.js

# 或使用 yep.sh（会自动设置端口）
bash yep.sh start-prod

# 手动指定端口（覆盖默认值）
NODE_ENV=production node dist/npm-package/dist/cli.js --port 9000

# 修改 LaunchAgent 部署端口
YEP_DEPLOY_PORT=9000 scripts/install-launchagents.sh
```

**说明**：
- 端口由 `NODE_ENV` 环境变量自动选择：
  - `NODE_ENV=production` → 默认 8022（生产模式）
  - 其他情况 → 默认 3400（开发模式）
- 开发模式（3400）和生产模式（8022）使用不同的默认端口，两种模式可以同时运行互不冲突
- 可通过 `PORT` 环境变量或 `--port` 参数覆盖默认端口
```

### 2. "生产模式" 描述（第 107-109 行）

**当前内容：**
```markdown
**生产模式**：
- 运行打包后的独立部署包
- 命令：`node dist/npm-package/dist/cli.js --port 8022` 或 `bash yep.sh start-prod`
```

**建议修改为：**
```markdown
**生产模式**：
- 运行打包后的独立部署包
- 命令：`NODE_ENV=production node dist/npm-package/dist/cli.js` 或 `bash yep.sh start-prod`
```

## 理由

1. **明确说明 NODE_ENV 的作用**：端口选择现在基于 NODE_ENV，用户需要知道这一点
2. **推荐最佳实践**：设置 `NODE_ENV=production` 是生产环境的标准做法
3. **消除歧义**：之前的文档说"默认 8022"，但代码实际上依赖 NODE_ENV，现在明确了这一点
4. **保持一致性**：文档与代码行为完全一致

## 验证

运行以下命令验证新行为：

```bash
# 1. 开发模式默认端口
pnpm dev
# 预期：http://localhost:3400

# 2. 生产模式默认端口（需要 NODE_ENV=production）
NODE_ENV=production node dist/npm-package/dist/cli.js
# 预期：http://localhost:8022

# 3. 未设置 NODE_ENV（退回开发模式默认值）
node dist/npm-package/dist/cli.js
# 预期：http://localhost:3400

# 4. 手动指定端口（覆盖默认值）
NODE_ENV=production PORT=9000 node dist/npm-package/dist/cli.js
# 预期：http://localhost:9000
```
