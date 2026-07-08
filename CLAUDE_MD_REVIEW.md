# CLAUDE.md 审查报告与修改建议

## 审查日期：2026-07-08

## 一、发现的问题

### 🔴 严重问题（必须修复）

#### 1. 错误的部署脚本路径（第 259-262 行）

**当前内容**：
```bash
scripts/deploy.sh                 # 服务端 rebuild/restart/verify，然后构建/安装 APK
scripts/deploy.sh --server-only   # 仅服务端
scripts/deploy.sh --apk-only      # 仅 APK
pnpm deploy -- --server-only      # 通过 package.json 使用同一入口
```

**问题**：
- ✅ `scripts/deploy.sh` 实际上**存在**（经验证）
- ❌ 但文档**没有提及 `yep.sh`**，这是主要的部署工具
- ❌ 缺少关键警告：`dist/npm-package/` 中必须用 `npm install`

**应修改为**：
```bash
# 推荐：使用 yep.sh 进行快速重构建和重启
bash yep.sh rebuild               # 重构建生产模式部署包
bash yep.sh restart-prod          # 重启生产模式
bash yep.sh restart-dev           # 重启开发模式
bash yep.sh status                # 查看服务状态

# 或使用 scripts/deploy.sh 进行完整部署（包括 APK）
scripts/deploy.sh                 # 交互式部署向导
scripts/deploy.sh --server-only   # 仅重构建和重启服务端
scripts/deploy.sh --apk-only      # 仅构建 APK
```

#### 2. 缺少"开发模式 vs 生产模式"核心概念（全文）

**问题**：
- ❌ 文档没有明确区分开发模式和生产模式
- ❌ 没有解释"重构建"的含义
- ❌ 没有说明修改代码只影响开发模式，生产模式需要重构建

**应添加新章节**（在"端口配置"后）：
```markdown
## 开发模式 vs 生产模式

### 关键概念

**开发模式**：
- 直接运行源代码，修改后自动重新编译
- 命令：`pnpm dev` 或 `bash yep.sh start-dev`
- 代码位置：`packages/server/dist/`, `packages/client/src/`
- 默认端口：3400
- 特点：Vite HMR 自动刷新，无需重构建

**生产模式**：
- 运行打包后的独立部署包
- 命令：`node dist/npm-package/dist/cli.js --port 8022` 或 `bash yep.sh start-prod`
- 代码位置：`dist/npm-package/`（完整打包产物）
- 默认端口：8022
- 特点：需要重构建才能看到代码修改

**重构建的含义**：
- 将当前源代码重新打包成生产模式的部署包（`dist/npm-package/`）
- 修改代码后，**只影响开发模式**（源码运行）
- 生产模式继续运行旧的打包代码，**必须重构建 + 重启**才能应用修改
```

#### 3. 缺少关键警告：依赖安装方法（全文）

**问题**：
- ❌ 没有警告在 `dist/npm-package/` 中不能用 `pnpm install`
- ❌ 这是一个常见错误，会导致路径问题

**应添加**（在"本地部署"章节中）：
```markdown
### ⚠️ 重要：依赖安装方法

在 `dist/npm-package/` 中安装依赖时，**必须使用 `npm install`，不能使用 `pnpm install`**。

**原因**：
- `dist/npm-package/` 是独立的打包产物，不是 workspace 的一部分
- pnpm 在 monorepo 中会尝试链接 workspace，导致路径错误
- npm 将其视为独立包，正确安装所有依赖到 node_modules/

**错误方法**：
```bash
cd dist/npm-package
pnpm install  # ❌ 会失败！
```

**正确方法**：
```bash
cd dist/npm-package
npm install --omit=dev  # ✅ 正确
```
```

#### 4. 端口示例不一致（第 67-68 行）

**当前内容**：
```bash
# 生产环境（默认 profile，端口 3400）
PORT=3400 pnpm start
```

**问题**：
- ❌ 生产模式默认端口是 8022，不是 3400
- ❌ 示例会导致混淆

**应修改为**：
```bash
# 生产环境（默认 profile，端口 8022）
PORT=8022 pnpm start

# 开发环境（dev profile，端口 3400）
PORT=3400 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

### 🟡 结构问题（影响可读性）

#### 5. "本地部署"章节位置不当（第 251 行）

**问题**：
- 当前位置：在"服务端日志"之后
- 问题：部署是核心操作，应该放在更前面

**建议**：
- 移动到"编辑代码后"章节之后
- 或创建独立的"部署与运维"大章节

#### 6. 日志环境变量位置混乱（第 247-278 行）

**当前内容**：
```
## 服务端日志
...（日志路径说明）

环境变量：
- `LOG_DIR`：自定义日志目录
- `LOG_FILE`：自定义日志文件名（默认：server.log）

## 本地部署
...（部署说明）

处理 Codex 编辑消息/session branch 问题时...

- `LOG_LEVEL`：最低级别...（更多日志环境变量）
```

**问题**：
- ❌ 日志环境变量被"本地部署"章节分割成两部分
- ❌ Codex 调试信息插在中间，逻辑不连贯

**应调整为**：
```
## 服务端日志
...（日志路径说明）

环境变量：
- `LOG_DIR`：自定义日志目录
- `LOG_FILE`：自定义日志文件名（默认：server.log）
- `LOG_LEVEL`：最低级别：fatal、error、warn、info、debug、trace（默认：info）
- `LOG_FILE_LEVEL`：文件日志的独立级别（默认：与 LOG_LEVEL 相同）
- `LOG_TO_FILE`：设为 `"true"` 可启用文件日志（默认：关闭）
- `LOG_PRETTY`：设为 `"false"` 可禁用控制台 pretty logs（默认：开启）

## 调试 Codex 会话分支问题
...（Codex 调试信息）

## 本地部署
...（部署说明）
```

### 🟢 次要问题（建议优化）

#### 7. 缺少 yep.sh 的完整说明

**建议**：添加 yep.sh 的使用说明：
```markdown
### yep.sh 项目管理脚本

`yep.sh` 是主要的项目管理工具，提供交互式菜单和命令行接口：

```bash
# 交互式菜单
bash yep.sh

# 命令行模式
bash yep.sh start-dev      # 启动开发模式
bash yep.sh start-prod     # 启动生产模式
bash yep.sh stop           # 停止所有服务
bash yep.sh restart-dev    # 重启开发模式
bash yep.sh restart-prod   # 重启生产模式
bash yep.sh status         # 查看服务状态
bash yep.sh rebuild        # 重构建项目
```

**yep.sh rebuild 流程**：
1. 运行 lint 和 typecheck
2. 构建客户端和服务端
3. 使用 npm 安装运行时依赖（不是 pnpm）
4. 提示用户选择重启模式
5. 执行部署验证
```

#### 8. "验证流程的自主边界"章节位置不当（第 137 行）

**问题**：
- 这是给 Claude 的行为指导，不是项目使用说明
- 应该放在文档开头或专门的 Claude 指导章节

**建议**：移动到文档开头，或创建"Claude 工作指导"章节

#### 9. 缺少快速开始指南

**建议**：在文档开头添加：
```markdown
## 快速开始

### 首次运行

```bash
# 安装依赖
pnpm install

# 启动开发模式
pnpm dev

# 访问 http://localhost:3400
```

### 修改代码后

```bash
# 开发模式自动刷新，无需操作

# 如需更新生产模式：
bash yep.sh rebuild
```

### 部署到生产

```bash
# 重构建并重启生产模式
bash yep.sh rebuild
# 选择 "1) 重启生产模式"
```
```

---

## 二、建议的完整章节顺序

1. ✅ 项目简介（保持不变）
2. **新增：快速开始**
3. ✅ 端口配置（保持不变）
4. **新增：开发模式 vs 生产模式**
5. ✅ 数据目录与 Profile（保持不变）
6. ✅ Provider 与功能配置（保持不变）
7. ✅ 编辑代码后（保持不变）
8. **重组：本地部署与重构建**（整合 yep.sh 和 scripts/deploy.sh）
9. ✅ 服务端日志（整合分散的环境变量）
10. ✅ 维护服务端（保持不变）
11. ✅ 客户端控制台日志（保持不变）
12. **新增：调试 Codex 会话分支问题**（从日志章节分离）
13. ✅ 校验会话数据（保持不变）
14. ✅ 校验工具结果（保持不变）
15. ✅ 类型系统（保持不变）
16. ✅ 依赖安全维护（保持不变）
17. ✅ Git 提交（保持不变）
18. ✅ 发布到 npm（保持不变）
19. ✅ 发布网站（保持不变）
20. **移动：验证流程的自主边界**（移到文档开头）
21. ✅ Android 模拟器测试（保持不变）
22. ✅ 浏览器控制（保持不变）
23. ✅ ChromeOS 调试（保持不变）

---

## 三、修改优先级

### 🔴 立即修复（影响正确性）

1. ✅ 添加"开发模式 vs 生产模式"章节
2. ✅ 添加依赖安装方法警告（npm vs pnpm）
3. ✅ 修正端口示例（3400 -> 8022）
4. ✅ 补充 yep.sh 使用说明

### 🟡 重要优化（影响可读性）

5. ✅ 整合分散的日志环境变量
6. ✅ 分离 Codex 调试信息到独立章节
7. ✅ 重组"本地部署"章节

### 🟢 可选改进（锦上添花）

8. ⚪ 添加快速开始指南
9. ⚪ 调整章节顺序
10. ⚪ 移动 Claude 行为指导到合适位置

---

## 四、修改后的完整文档

已创建修改后的完整 CLAUDE.md 内容，保存在：
- **CLAUDE.md.new**（建议的新版本）
- **CLAUDE.md.diff**（差异对比）

由于 CLAUDE.md 被系统保护无法直接修改，请手动应用这些修改。

---

## 五、验证清单

修改完成后，请验证：

- [ ] `scripts/deploy.sh` 存在且可执行
- [ ] `yep.sh` 存在且可执行
- [ ] 端口配置示例正确（开发 3400，生产 8022）
- [ ] 所有脚本路径正确
- [ ] 依赖安装方法警告清晰
- [ ] 开发/生产模式概念清晰
- [ ] 章节逻辑连贯，无重复

---

## 六、总结

**主要问题**：
1. ❌ 缺少核心概念解释（开发 vs 生产模式）
2. ❌ 缺少关键警告（npm vs pnpm）
3. ❌ 章节组织混乱（日志环境变量被分割）
4. ❌ 缺少主要工具说明（yep.sh）

**修改后的改进**：
1. ✅ 清晰区分开发模式和生产模式
2. ✅ 明确警告依赖安装陷阱
3. ✅ 重组章节，逻辑连贯
4. ✅ 完整说明 yep.sh 和 scripts/deploy.sh
5. ✅ 修正所有错误示例和路径

**文档质量提升**：
- 从"能用但混乱"→"清晰且准确"
- 从"缺少关键信息"→"完整且有警示"
- 从"章节散乱"→"逻辑连贯"
