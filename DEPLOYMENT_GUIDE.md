# 本地部署指南

## 问题分析：为什么会尝试错误的方法？

### 误导来源（CLAUDE.md 第 259-262 行）

```bash
scripts/deploy.sh                 # 服务端 rebuild/restart/verify，然后构建/安装 APK
scripts/deploy.sh --server-only   # 仅服务端
scripts/deploy.sh --apk-only      # 仅 APK
pnpm deploy -- --server-only      # 通过 package.json 使用同一入口
```

**问题**：
1. ❌ `scripts/deploy.sh` **不存在**
2. ❌ `scripts/redeploy-server.sh` 提到但路径错误
3. ❌ 没有明确说明使用 `yep.sh` 作为主要部署工具

### 为什么我会尝试 `pnpm install`？

**错误思路**：
1. 项目中一直使用 pnpm（pnpm dev, pnpm build, pnpm typecheck）
2. 自然延续了使用 pnpm 的惯性
3. **没有意识到 `dist/npm-package/` 是独立打包产物**

**正确理解**：
- `dist/npm-package/` 是完整的 npm 包，不是 workspace 的一部分
- 应该用 `npm install`，而不是 `pnpm install`

---

## 核心概念澄清

### 开发模式 vs 生产模式

| 维度 | 开发模式 | 生产模式 |
|------|---------|---------|
| **运行内容** | 源代码（实时编译） | 打包后的代码 |
| **代码位置** | `packages/*/src/`, `packages/*/dist/` | `dist/npm-package/` |
| **启动命令** | `pnpm dev` | `node dist/npm-package/dist/cli.js` |
| **默认端口** | 3400 | 8022 |
| **自动刷新** | ✅ Vite HMR | ❌ 需要重启 |
| **修改代码** | 立即生效 | 需要重构建 + 重启 |
| **适用场景** | 本地开发调试 | 测试部署包、生产环境 |

### 重构建的含义

**用户的理解是对的：**

```
修改代码
    ↓
只影响开发模式（源码运行）
    ↓
生产模式还在运行旧的打包代码
    ↓
需要"重构建"将新代码打包到 dist/npm-package/
    ↓
需要"重启"生产模式服务才能应用新代码
```

**关键点**：
- 修改 `packages/client/src/lib/preprocessMessages.ts`
- 开发模式（pnpm dev）：✅ **自动生效**（Vite 自动重编译）
- 生产模式（8022端口）：❌ **不会生效**（还在运行旧的 dist/npm-package/）
- 必须：重构建 → 重启生产模式

---

## 正确的部署流程

### 方法 1：使用 yep.sh（推荐）

```bash
# 重构建生产模式部署包
bash yep.sh rebuild

# yep.sh rebuild 会自动执行：
# 1. pnpm lint
# 2. pnpm typecheck
# 3. pnpm --filter client build
# 4. pnpm build:bundle
# 5. cd dist/npm-package && npm install --omit=dev  # ✅ 使用 npm，不是 pnpm
# 6. chmod +x dist/npm-package/dist/cli.js
# 7. 提示用户选择重启模式（生产/开发）
```

**优势**：
- ✅ 自动检测当前运行模式
- ✅ 包含部署验证（buildId 一致性检查）
- ✅ 优雅的错误处理
- ✅ 正确的依赖安装方法（npm install）

### 方法 2：手动执行（了解原理）

```bash
# 1. 验证代码
pnpm typecheck
pnpm lint

# 2. 构建完整 bundle
pnpm build:bundle

# 3. 安装运行时依赖（关键：必须用 npm）
cd dist/npm-package
npm install --omit=dev --no-audit --no-fund
cd ../..

# 4. 设置执行权限
chmod +x dist/npm-package/dist/cli.js
chmod +x dist/npm-package/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

# 5. 停止旧服务
bash yep.sh stop

# 6. 启动新服务（生产模式）
node dist/npm-package/dist/cli.js --port 8022 > /tmp/yep-server.log 2>&1 &

# 7. 验证服务
sleep 3
curl http://localhost:8022/api/health
```

---

## 关键注意事项

### ⚠️ 必须使用 npm install，不能用 pnpm install

**错误**：
```bash
cd dist/npm-package
pnpm install  # ❌ 失败！
```

**原因**：
- pnpm 在 monorepo 环境中会尝试链接 workspace
- 导致路径解析错误：`/dist/npm-package/dist/npm-package/dist/cli.js`
- `dist/npm-package/` 应该是独立的 npm 包

**正确**：
```bash
cd dist/npm-package
npm install --omit=dev  # ✅ 成功
```

**原因**：
- npm 将其视为独立包
- 正确安装所有依赖到 node_modules/
- 不会尝试链接回 workspace

### 📝 yep.sh 已经实现了正确方法

**yep.sh 第 678-682 行**：
```bash
# 安装运行时依赖（参考 redeploy-server.sh 第249-251行）
print_info "安装运行时依赖到 dist/npm-package ..."
(cd dist/npm-package && npm install --omit=dev --no-audit --no-fund --silent)
chmod +x dist/npm-package/dist/cli.js 2>/dev/null || true
chmod +x dist/npm-package/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
print_success "运行时依赖安装完成"
```

**这就是正确的方法！**

---

## 实际案例：本次修复流程分析

### 我的操作（手动）

```bash
# 1. 修改代码
vim packages/client/src/lib/preprocessMessages.ts

# 2. 验证
pnpm typecheck  # ✅
pnpm lint       # ✅

# 3. 构建客户端
cd packages/client && pnpm build  # ✅

# 4. 构建 bundle
pnpm build:bundle  # ✅

# 5. 安装依赖（第一次尝试 - 错误）
cd dist/npm-package
pnpm install  # ❌ 失败

# 6. 安装依赖（第二次尝试 - 正确）
npm install  # ✅ 成功

# 7. 重启服务
node dist/npm-package/dist/cli.js --port 8022 &  # ✅
```

### 应该使用的方法（yep.sh）

```bash
# 1. 修改代码
vim packages/client/src/lib/preprocessMessages.ts

# 2. 重构建
bash yep.sh rebuild
# 自动执行 lint → typecheck → build → npm install → 提示重启

# 3. 选择重启生产模式
# （yep.sh 会自动提示）
```

---

## 总结

### ✅ 正确理解

1. **开发模式**：运行源代码，修改立即生效
2. **生产模式**：运行打包代码，需要重构建 + 重启
3. **重构建**：将当前源代码重新打包成 `dist/npm-package/`
4. **依赖安装**：`dist/npm-package/` 中必须用 `npm install`

### 📌 推荐做法

**修改代码后：**
```bash
bash yep.sh rebuild
# 然后按提示选择重启模式
```

**这比手动操作更可靠！**

### 🔧 CLAUDE.md 应该改正的内容

**当前（误导）**：
```bash
scripts/deploy.sh                 # 不存在！
scripts/deploy.sh --server-only   # 不存在！
```

**应该改为**：
```bash
bash yep.sh rebuild               # 重构建生产模式部署包
bash yep.sh restart-prod          # 重启生产模式
bash yep.sh restart-dev           # 重启开发模式
bash yep.sh status                # 查看服务状态
```

**关键补充**：
```bash
# 在 dist/npm-package/ 中安装依赖时，必须使用 npm install
# 不能使用 pnpm install（会导致 workspace 链接问题）
```
