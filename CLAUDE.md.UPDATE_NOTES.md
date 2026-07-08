# CLAUDE.md 更新说明

CLAUDE.md 文件受保护无法自动修改，以下是需要手动更新的内容：

---

## 需要更新的章节

### 1. 端口配置章节（第 52-82 行）

**替换为**：

```markdown
## 端口配置

项目有两种运行模式，使用不同的端口以避免冲突。

### 开发模式（pnpm dev）

**默认端口：3400**

所有端口都从单个 `PORT` 环境变量派生：

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

---

### 2. "开发模式 vs 生产模式"章节（第 84-105 行）

**保持不变**，内容已经正确。

---

### 3. "运行多个实例"章节（第 119-140 行）

**删除或注释掉这段**：

```bash
# 生产环境（默认 profile，端口 8022）
PORT=8022 pnpm start
```

**原因**：`pnpm start` 不是真正的生产模式，会造成混淆。

**替换为**：

```bash
# 生产环境（默认 profile，端口 8022）
node dist/npm-package/dist/cli.js --port 8022
```

---

### 4. 添加新章节：模式详细说明

在"开发模式 vs 生产模式"章节后添加：

```markdown
## 模式详细说明

详细的模式对比和使用指南请参考：[docs/DEPLOYMENT_MODES.md](docs/DEPLOYMENT_MODES.md)

### 为什么不使用 `pnpm start`？

你可能会在 `package.json` 中看到 `pnpm start` 命令。**这不是真正的生产模式！**

`pnpm start` 运行的是 `NODE_ENV=production node packages/server/dist/index.js`，它：
- 依赖 pnpm workspace 符号链接
- 无法独立部署
- 不是完整的 Bundle

真正的生产模式应该使用：
```bash
node dist/npm-package/dist/cli.js --port 8022
```

这才是可以独立部署的完整 Bundle。详细区别见 [docs/DEPLOYMENT_MODES.md](docs/DEPLOYMENT_MODES.md)。
```

---

## 总结

主要变更：
1. ✅ 明确开发模式端口 3400
2. ✅ 明确生产模式端口 8022
3. ✅ 说明生产模式使用 Bundle（`dist/npm-package/dist/cli.js`）
4. ✅ 删除 `pnpm start` 的误导性示例
5. ✅ 添加详细文档链接（`docs/DEPLOYMENT_MODES.md`）

这些修改消除了端口和模式的混淆，让开发者清楚：
- 开发时用 `pnpm dev`（3400）
- 部署时用 Bundle（8022）
- 两种模式就够了！
