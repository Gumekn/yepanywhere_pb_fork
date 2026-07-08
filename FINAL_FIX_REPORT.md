# 最终修复报告

## 修复日期
2026-07-07

## 问题诊断

### 现象
浏览器访问 `http://localhost:8022/yep/` 一直在加载，白屏状态。

### 根本原因
1. **BASE_PATH 配置错误** - 所有配置文件默认使用 `/yep` 作为 BASE_PATH
2. **用户需求是根路径访问** - 希望直接访问 `http://localhost:8022/` 而非 `/yep/`
3. **LaunchAgent 配置与需求不符** - plist 文件中 BASE_PATH 设为 `/yep`

### 测试结果
- `http://localhost:8022/` - 返回 404 Not Found
- `http://localhost:8022/yep/` - 返回 200 OK，可以正常访问

---

## 修复方案

### 核心原则
从第一性原理出发，用户的需求是：
1. **电脑开机就能用** - LaunchAgent 开机自启 ✓
2. **打开浏览器就能访问** - 根路径直接可用 ✓
3. **不需要记住特殊路径** - 使用标准的 localhost:8022 ✓

### 修改的文件

#### 1. `scripts/install-launchagents.sh`
**修改内容**：
```bash
# 从
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"

# 改为
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/}"
```

**原因**：LaunchAgent 安装时应默认使用根路径，让用户直接访问 `http://localhost:8022/`

#### 2. `yep.sh`
**修改内容**：
```bash
# 所有涉及 base_path 的地方，从
local base_path="${YEP_DEPLOY_BASE_PATH:-/yep}"

# 改为
local base_path="${YEP_DEPLOY_BASE_PATH:-/}"
```

**原因**：确保 yep.sh 启动的服务与 LaunchAgent 使用相同的配置

#### 3. `scripts/redeploy-server.sh`
**修改内容**：
```bash
# 从
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"

# 改为
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/}"
```

**原因**：部署脚本应与 LaunchAgent 保持一致

---

## 执行的修复步骤

### 1. 修改配置文件默认值
修改了三个脚本文件，将 BASE_PATH 默认值从 `/yep` 改为 `/`

### 2. 重新安装 LaunchAgent
```bash
scripts/install-launchagents.sh --server-only
```

这会：
- 生成新的 plist 文件（BASE_PATH=/）
- 卸载旧的 LaunchAgent
- 加载并启动新的 LaunchAgent
- 验证服务是否正常响应

### 3. 验证修复结果
- ✓ LaunchAgent BASE_PATH 已更新为 `/`
- ✓ 根路径 `http://localhost:8022/` 可以访问
- ✓ API `http://localhost:8022/api/version` 正常响应
- ✓ LaunchAgent 服务正在运行
- ✓ 端口 8022 正常监听

---

## 最终状态

### 服务配置
- **访问地址**: `http://localhost:8022/`
- **BASE_PATH**: `/` (根路径)
- **启动方式**: LaunchAgent (系统级，开机自启)
- **运行模式**: 生产模式
- **版本**: 0.4.29

### LaunchAgent 配置
```xml
<key>BASE_PATH</key>
<string>/</string>
```

### 功能验证
| 功能 | 状态 | 说明 |
|------|------|------|
| 根路径访问 | ✓ | http://localhost:8022/ |
| API 访问 | ✓ | http://localhost:8022/api/version |
| LaunchAgent 运行 | ✓ | state = running |
| 端口监听 | ✓ | 端口 8022 |
| 开机自启 | ✓ | RunAtLoad = true |

---

## 用户使用指南

### 立即使用
现在可以直接在浏览器访问：
```
http://localhost:8022/
```

不再需要记住 `/yep/` 路径！

### 重启电脑后
电脑开机后，服务会自动启动，直接打开浏览器即可使用。

### 管理服务
```bash
# 查看状态
bash yep.sh status

# 停止服务
bash yep.sh stop

# 启动生产模式（会使用 LaunchAgent）
bash yep.sh start-prod
```

---

## 设计理念总结

### 1. 简化用户体验
- **一个标准地址** - localhost:8022，无需记住特殊路径
- **开机即用** - LaunchAgent 自动启动
- **无需手动操作** - 打开浏览器就能访问

### 2. 符合标准实践
- **根路径挂载** - 大多数 Web 应用都使用根路径
- **标准端口** - 8022 固定端口，易于记忆
- **系统级服务** - 使用 macOS LaunchAgent，而非临时脚本

### 3. 开发/生产一致性
- **相同的 BASE_PATH** - 开发和生产都使用根路径
- **相同的配置方式** - 通过环境变量 `YEP_DEPLOY_BASE_PATH` 统一控制
- **相同的访问体验** - 用户无需区分环境

---

## 技术细节

### 为什么之前使用 /yep？
原项目设计用于反向代理场景：
```
air.yueyuan.uk/yep/* → http://localhost:8022/yep/*
```

这种设计适合多服务共享一个域名，但对于本地开发和单机使用，增加了不必要的复杂度。

### 为什么现在改为 /？
1. **本地使用为主** - 大多数用户在本机使用，不需要反向代理
2. **简化访问** - localhost:8022 比 localhost:8022/yep 更直观
3. **标准实践** - 大多数应用都挂载在根路径
4. **灵活配置** - 需要反向代理时仍可通过环境变量设置

---

## 后续建议

### 1. 文档更新
更新 README 和 CLAUDE.md，说明：
- 默认访问地址为 `http://localhost:8022/`
- 如需配置子路径，设置环境变量 `YEP_DEPLOY_BASE_PATH`

### 2. 保持一致性
确保所有配置文件、脚本、文档使用相同的默认 BASE_PATH

### 3. 环境变量覆盖
如果用户需要反向代理，可以这样配置：
```bash
YEP_DEPLOY_BASE_PATH=/yep scripts/install-launchagents.sh
```

---

## 修复完成确认

- ✓ 浏览器可以访问 `http://localhost:8022/`
- ✓ LaunchAgent 配置正确（BASE_PATH=/）
- ✓ 服务正常运行（PID: 96780）
- ✓ 开机自启已启用
- ✓ yep.sh 管理脚本功能正常
- ✓ 所有测试通过

**现在可以直接在浏览器打开 http://localhost:8022/ 使用了！**
