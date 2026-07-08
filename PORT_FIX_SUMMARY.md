# 端口配置修复总结

## 问题分析

### 原始问题
从第一性原理出发，项目应该有两种明确的运行模式：
1. **开发模式**：源码运行，热重载，用于快速迭代
2. **生产模式**：运行构建后的 bundle，用于稳定部署

但原代码中，**开发模式和生产模式都默认使用 3400 端口**，导致：
- 同一种模式在不同启动方式下可能使用不同端口（3400 或 8022）
- 端口配置混乱，不符合"一个模式一个默认端口"的原则
- 文档说生产模式是 8022，但代码默认是 3400

### 根本原因
代码中所有默认端口都硬编码为 3400：
- `packages/server/src/config.ts`: `port: parseIntOrDefault(process.env.PORT, 3400)`
- `packages/server/src/services/NetworkBindingService.ts`: `const DEFAULT_PORT = 3400`
- `packages/server/src/index.ts`: `defaultPort: 3400`

这导致无论什么模式，不显式指定端口时都会使用 3400。

## 修复方案

### 核心原则
**根据 `NODE_ENV` 环境变量自动选择默认端口：**
- `NODE_ENV=production` → 默认端口 8022（生产模式）
- 其他情况 → 默认端口 3400（开发模式）

### 修改的文件

#### 1. `packages/server/src/config.ts`
修改三处端口配置逻辑：

**端口配置（第 360-366 行）**
```typescript
// 修改前
port: parseIntOrDefault(process.env.PORT, 3400),

// 修改后
port: parseIntOrDefault(
  process.env.PORT,
  process.env.NODE_ENV === "production" ? 8022 : 3400,
),
```

**Vite 端口配置（第 373-379 行）**
```typescript
// 修改后：Vite 只在开发模式使用，计算时考虑 NODE_ENV
vitePort: parseIntOrDefault(
  process.env.VITE_PORT,
  parseIntOrDefault(
    process.env.PORT,
    process.env.NODE_ENV === "production" ? 8022 : 3400,
  ) + 2,
),
```

**Claude Bridge 服务端 URL（第 349-355 行）**
```typescript
// 修改后：Claude Bridge 连接主服务时考虑 NODE_ENV
claudeBridgeServerUrl:
  process.env.YEP_SERVER_URL ??
  process.env.YEP_ANYWHERE_SERVER_URL ??
  `http://127.0.0.1:${parseIntOrDefault(
    process.env.PORT,
    process.env.NODE_ENV === "production" ? 8022 : 3400,
  )}`,
```

#### 2. `packages/server/src/services/NetworkBindingService.ts`
修改默认端口常量（第 18-23 行）：

```typescript
// 修改前
const DEFAULT_PORT = 3400;

// 修改后
// Default port based on NODE_ENV:
// - Development: 3400 (source code, hot reload)
// - Production: 8022 (bundled package)
const DEFAULT_PORT = process.env.NODE_ENV === "production" ? 8022 : 3400;
```

#### 3. `packages/server/src/index.ts`
修改 NetworkBindingService 初始化（第 426-434 行）：

```typescript
// 修改前
const networkBindingService = new NetworkBindingService({
  dataDir: config.dataDir,
  cliPortOverride: config.cliPortOverride ? config.port : undefined,
  cliHostOverride: config.cliHostOverride ? config.host : undefined,
  defaultPort: 3400,
});

// 修改后
const networkBindingService = new NetworkBindingService({
  dataDir: config.dataDir,
  cliPortOverride: config.cliPortOverride ? config.port : undefined,
  cliHostOverride: config.cliHostOverride ? config.host : undefined,
  // Default port based on NODE_ENV:
  // - Development: 3400 (source code, hot reload)
  // - Production: 8022 (bundled package)
  defaultPort: process.env.NODE_ENV === "production" ? 8022 : 3400,
});
```

## 验证方法

### 1. 类型检查和 Lint
```bash
pnpm typecheck  # ✓ 通过
pnpm lint       # ✓ 通过
```

### 2. 开发模式验证
```bash
# 不设置 PORT，应该使用 3400
pnpm dev
# 预期：服务端启动在 http://localhost:3400
```

### 3. 生产模式验证
```bash
# 先构建
pnpm build:bundle

# 不设置 PORT，应该使用 8022
NODE_ENV=production node dist/npm-package/dist/cli.js
# 预期：服务端启动在 http://localhost:8022
```

### 4. 手动指定端口（应该覆盖默认值）
```bash
# 开发模式手动指定端口
PORT=4000 pnpm dev
# 预期：服务端启动在 http://localhost:4000

# 生产模式手动指定端口
NODE_ENV=production PORT=9000 node dist/npm-package/dist/cli.js
# 预期：服务端启动在 http://localhost:9000
```

### 5. yep.sh 脚本验证
```bash
# 开发模式（应该使用 3400）
bash yep.sh start-dev
# 预期：端口 3400

# 生产模式（应该使用 8022）
bash yep.sh start-prod
# 预期：端口 8022
```

## 行为变化

### 修改前
- 所有模式默认都使用 3400
- 必须通过 yep.sh 脚本或手动设置 PORT 才能使用不同端口
- 直接运行 `node dist/npm-package/dist/cli.js` 会使用 3400，与文档不符

### 修改后
- **开发模式（NODE_ENV != production）**：默认 3400
- **生产模式（NODE_ENV = production）**：默认 8022
- 符合第一性原理：一个模式一个默认端口
- 与文档和 yep.sh 脚本的行为一致

## 影响范围

### 不受影响的场景
- 使用 yep.sh 脚本启动（它会显式设置端口）
- 使用环境变量 PORT 显式指定端口
- 使用 CLI 参数 `--port` 指定端口
- 开发模式（`pnpm dev`）默认行为不变

### 受影响的场景
- **直接运行生产 bundle 而不设置环境变量**：
  ```bash
  # 修改前：使用 3400
  node dist/npm-package/dist/cli.js
  
  # 修改后：使用 8022（因为 NODE_ENV=production）
  NODE_ENV=production node dist/npm-package/dist/cli.js
  ```

### 兼容性考虑
如果有用户直接运行 `node dist/npm-package/dist/cli.js` 而不设置 `NODE_ENV=production`，端口仍然是 3400（因为默认是开发模式）。

**推荐做法**：
- 生产环境启动时总是设置 `NODE_ENV=production`
- 或者显式指定端口：`node dist/npm-package/dist/cli.js --port 8022`

## 后续建议

1. **更新 CLAUDE.md 文档**，明确说明：
   - 开发模式默认 3400
   - 生产模式默认 8022（需要 NODE_ENV=production）
   
2. **更新 LaunchAgent 配置**（如果使用），确保设置 `NODE_ENV=production`

3. **更新部署文档**，说明生产环境应该设置 NODE_ENV

## 总结

这次修复从第一性原理出发，消除了端口配置的混乱：
- ✓ 开发模式和生产模式有明确的默认端口
- ✓ 代码行为与文档一致
- ✓ 符合"一个模式一个默认端口"的设计原则
- ✓ 通过 NODE_ENV 自动选择，无需手动干预
- ✓ 保持向后兼容（可通过 PORT 环境变量或 --port 参数覆盖）
