# 部署模式说明

本项目支持两种运行模式：**开发模式**和**生产模式**。

---

## 模式对比

| 特性 | 开发模式 (Development) | 生产模式 (Production) |
|------|----------------------|----------------------|
| **启动命令** | `pnpm dev` 或 `bash yep.sh start-dev` | `node dist/npm-package/dist/cli.js --port 8022` 或 `bash yep.sh start-prod` |
| **默认端口** | 3400 | 8022 |
| **运行内容** | TypeScript 源码（通过 tsx） | 独立打包的 Bundle |
| **依赖结构** | Monorepo workspace | 独立的 node_modules |
| **热重载** | ✅ 支持（前端 HMR + 后端自动重启） | ❌ 不支持 |
| **构建要求** | 无需构建，直接运行源码 | 需要先运行 `pnpm build:bundle` |
| **可移植性** | ❌ 需要完整的 monorepo 环境 | ✅ 可以独立部署到任何服务器 |
| **适用场景** | 日常开发、调试 | 实际部署、生产环境 |

---

## 一、开发模式 (Development Mode)

### 特点

- **实时热重载**：修改代码后自动重新编译和重启
- **直接运行源码**：使用 tsx 运行 TypeScript 源文件
- **开发友好**：立即看到修改效果，无需手动重启

### 启动方式

```bash
# 方式 1: 使用 yep.sh
bash yep.sh start-dev

# 方式 2: 直接使用 pnpm
PORT=3400 pnpm dev
```

### 端口配置

- 主服务端：`3400`
- 维护服务端：`3401`
- Vite dev server：`3402`

### 技术实现

开发模式通过 `scripts/dev.js` 启动，它：
1. 使用 `tsx` 加载器运行 TypeScript 源码
2. 监听 `packages/server/src/` 和 `packages/shared/src/` 的文件变化
3. 文件变化时自动重启后端进程
4. 前端通过 Vite HMR 实现热模块替换

### 依赖结构

```
packages/
├── server/
│   └── src/index.ts  ← 直接运行
├── shared/
│   └── src/          ← 通过 workspace 链接
└── client/
    └── src/          ← Vite dev server
```

---

## 二、生产模式 (Production Mode)

### 特点

- **独立部署包**：所有依赖已打包，可以脱离 monorepo 运行
- **完整 Bundle**：包含编译后的代码和所有运行时依赖
- **可移植性强**：可以复制到任何服务器，或发布到 npm

### 启动方式

```bash
# 方式 1: 使用 yep.sh（推荐）
bash yep.sh start-prod

# 方式 2: 直接运行 CLI
node dist/npm-package/dist/cli.js --port 8022

# 方式 3: LaunchAgent 自动启动
YEP_DEPLOY_PORT=8022 scripts/install-launchagents.sh
```

### 端口配置

- 主服务端：`8022`（可通过 `--port` 参数或 `YEP_DEPLOY_PORT` 环境变量修改）

### 技术实现

生产模式的 Bundle 通过 `pnpm build:bundle` 构建，它：
1. 编译所有 TypeScript 代码
2. 将 `@yep-anywhere/shared` 打包到 `bundled/` 目录
3. 重写所有导入路径
4. 生成独立的 `package.json`
5. 创建可执行的 CLI 入口

### 依赖结构

```
dist/npm-package/
├── dist/
│   ├── cli.js          ← 可执行入口
│   └── ...             ← 编译后的服务端代码
├── bundled/
│   └── @yep-anywhere/
│       └── shared/     ← 打包的共享代码
├── client-dist/        ← 编译后的前端静态文件
├── node_modules/       ← 独立的运行时依赖
└── package.json        ← 独立的包配置
```

### 构建流程

```bash
# 1. 重构建项目（包含验证、构建、安装依赖）
bash yep.sh rebuild

# 或者手动执行各步骤：
pnpm lint               # 验证代码风格
pnpm typecheck          # 类型检查
pnpm build:bundle       # 构建 Bundle
cd dist/npm-package && npm install --omit=dev  # 安装运行时依赖
```

---

## 三、为什么 `pnpm start` 不是生产模式？

你可能会在 `package.json` 中看到 `pnpm start` 命令：

```json
{
  "start": "NODE_ENV=production node packages/server/dist/index.js"
}
```

**这不是真正的生产模式！** 原因：

### 依赖差异

| 特性 | `pnpm start` | 真正的生产模式 |
|------|-------------|---------------|
| 运行位置 | `packages/server/dist/index.js` | `dist/npm-package/dist/cli.js` |
| 依赖解析 | 通过 pnpm workspace 符号链接 | 独立的 `node_modules` |
| `@yep-anywhere/shared` | `workspace:*` 链接 | 打包到 `bundled/` |
| 可移植性 | ❌ 需要完整 monorepo | ✅ 可独立部署 |

### `pnpm start` 的角色

它是一个 **Workspace 编译模式**（Compiled Workspace Mode）：
- 设置了 `NODE_ENV=production`
- 但仍依赖 workspace 环境
- 介于开发和生产之间的中间态
- **不建议在生产环境使用**

### 使用场景

`pnpm start` 主要用于：
- 内部测试编译后的代码
- CI/CD 流程中的验证步骤
- **不适合实际部署**

---

## 四、工作流程

### 日常开发流程

```
1. 修改代码
   ↓
2. 开发模式自动重载 (3400)
   ↓
3. 实时看到效果
```

### 部署流程

```
1. 完成开发
   ↓
2. 运行 bash yep.sh rebuild
   ↓
3. 构建 Bundle (dist/npm-package/)
   ↓
4. 重启生产服务 (8022)
   ↓
5. 验证部署
```

### 同时运行两种模式

开发和生产模式可以同时运行，因为它们使用不同的端口：

```bash
# 终端 1: 启动开发模式
bash yep.sh start-dev   # 端口 3400

# 终端 2: 启动生产模式
bash yep.sh start-prod  # 端口 8022
```

这样可以：
- 在开发模式中实时测试新功能
- 在生产模式中验证稳定版本
- 对比两个版本的行为差异

---

## 五、常见问题

### Q: 为什么生产模式默认端口是 8022 而不是 3400？

**A:** 设计为不同端口是为了：
1. 避免与开发模式冲突
2. 允许两种模式同时运行
3. 明确区分开发和生产环境

### Q: 修改代码后为什么生产模式没有更新？

**A:** 生产模式运行的是打包后的 Bundle (`dist/npm-package/`)，不是源码。修改代码后：
1. 开发模式会自动重载（实时看到效果）
2. 生产模式继续运行旧代码
3. 必须重新构建 Bundle 并重启生产服务

### Q: 如何修改端口？

**A:** 
- **开发模式**：修改 `yep.sh` 中的 `DEV_PORT=3400`
- **生产模式**：修改 `yep.sh` 中的 `PROD_PORT=8022`，或使用 `--port` 参数

### Q: Bundle 可以发布到 npm 吗？

**A:** 可以！`dist/npm-package/` 就是为发布到 npm 设计的独立包：

```bash
cd dist/npm-package
npm publish
```

用户安装后可以直接运行：

```bash
npm install -g yepanywhere
yepanywhere --port 8022
```

---

## 六、技术细节

### 路径重写

在构建 Bundle 时，所有 `@yep-anywhere/shared` 的导入会被重写：

**源码**：
```typescript
import { something } from '@yep-anywhere/shared';
```

**Bundle 中**：
```typescript
import { something } from '../bundled/@yep-anywhere/shared/dist/index.js';
```

### 构建产物对比

**开发模式构建产物**（仅用于类型检查）：
```
packages/server/dist/    # TypeScript 编译输出
packages/client/dist/    # Vite 构建输出
packages/shared/dist/    # TypeScript 编译输出
```

**生产模式构建产物**（可独立部署）：
```
dist/npm-package/        # 完整的独立包
```

---

## 总结

**简单记住**：
- **开发时用开发模式** (3400) - 实时看效果
- **部署时用生产模式** (8022) - 稳定可靠
- **两种模式就够了** - 不需要中间态

需要帮助？运行 `bash yep.sh` 查看交互式菜单。
