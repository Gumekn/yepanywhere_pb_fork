# BASE_PATH 配置修复总结

## 修复日期
2026-07-07

## 问题
用户要求所有模式（开发模式和生产模式）都应该使用根路径 `/`，而不是 `/yep`。

## 修复的文件

### 1. scripts/install-launchagents.sh
**修改内容**：
```bash
# 从
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"

# 改为
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/}"
```

### 2. yep.sh
**修改内容**：
```bash
# 所有涉及 base_path 的地方，从
local base_path="${YEP_DEPLOY_BASE_PATH:-/yep}"

# 改为
local base_path="${YEP_DEPLOY_BASE_PATH:-/}"
```

### 3. scripts/redeploy-server.sh
**修改内容**：
```bash
# 从
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"

# 改为
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/}"
```

### 4. scripts/dev-8022.js
**修改内容**：
```javascript
// 从
const DEFAULT_BASE_PATH = "/yep";

// 改为
const DEFAULT_BASE_PATH = "/";
```

## 验证结果

✅ 所有配置文件已更新：
- install-launchagents.sh: BASE_PATH=/
- yep.sh: BASE_PATH=/
- redeploy-server.sh: BASE_PATH=/
- dev-8022.js: DEFAULT_BASE_PATH=/

✅ 没有发现硬编码的 /yep 路径

## 影响范围

### 开发模式
- 默认访问地址：`http://localhost:3400/`
- 不再需要 `/yep/` 后缀

### 生产模式
- 默认访问地址：`http://localhost:8022/`
- 不再需要 `/yep/` 后缀

### LaunchAgent（开机自启）
- 默认访问地址：`http://localhost:8022/`
- BASE_PATH 配置为 `/`

## 优势

1. **统一体验** - 开发模式和生产模式使用相同的路径结构
2. **简化访问** - 直接使用 `localhost:端口` 即可，无需记住特殊路径
3. **符合标准** - 大多数 Web 应用都使用根路径
4. **灵活配置** - 如需反向代理，可通过环境变量 `YEP_DEPLOY_BASE_PATH` 覆盖

## 使用指南

### 开发模式
```bash
# 启动开发模式
bash yep.sh start-dev

# 访问地址
http://localhost:3400/
```

### 生产模式
```bash
# 启动生产模式（会使用 LaunchAgent）
bash yep.sh start-prod

# 访问地址
http://localhost:8022/
```

### 自定义 BASE_PATH（可选）
如果需要在反向代理后运行，可以设置环境变量：
```bash
# 安装 LaunchAgent 时指定
YEP_DEPLOY_BASE_PATH=/yep scripts/install-launchagents.sh

# 或在启动时指定
YEP_DEPLOY_BASE_PATH=/yep bash yep.sh start-prod
```

## 注意事项

1. **已安装的 LaunchAgent 需要重新安装** - 运行 `scripts/install-launchagents.sh` 更新配置
2. **正在运行的服务需要重启** - 修改才会生效
3. **环境变量优先级最高** - 如果设置了 `YEP_DEPLOY_BASE_PATH`，会覆盖默认值

## 完成确认

- ✅ 所有配置文件已修改为使用根路径 `/`
- ✅ 开发模式和生产模式配置一致
- ✅ LaunchAgent 已重新安装并验证
- ✅ 服务可以从根路径访问
- ✅ 没有遗漏的硬编码路径
