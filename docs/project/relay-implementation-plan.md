# Relay Server 实现计划

## 总览

Relay server 用来让手机客户端连接到 NAT 后面的 yepanywhere server。Relay 本身是一个“哑管道”：它只负责把客户端和服务器配对，并转发加密消息，不检查消息内容。

## 架构

```text
Yepanywhere Server                     Relay                          Phone
      |                                  |                               |
      |-- WS (waiting) ---------------->| <- stored in waiting map      |
      |                                  |                               |
      |   [phone connects, claims it]    |                               |
      |                                  |<------------------------------ |
      |-- WS (pipe to phone 1) -------->|<=============================>|
      |-- WS (waiting) ---------------->| <- new waiting (auto-opened)  |
      |                                  |                               |
      |   [another phone connects]       |                               |
      |                                  |                         Phone 2
      |-- WS (pipe to phone 1) -------->|<============================> Phone 1
      |-- WS (pipe to phone 2) -------->|<============================> Phone 2
      |-- WS (waiting) ---------------->| <- always one waiting         |
```

- 每台手机都有一条专用 server connection，不做 multiplexing。
- 一条 waiting connection 被认领后，yepanywhere 会立刻再打开一条新的 waiting connection。
- Relay 对每个 username 只维护一条 waiting connection。
- Relay 只做转发，端到端加密发生在 phone 和 yepanywhere 之间。

## 协议

```typescript
// Server -> Relay (on connect)
{ type: "server_register", username: string, installId: string }

// Relay -> Server
{ type: "server_registered" }
{ type: "server_rejected", reason: "username_taken" | "invalid_username" }

// Phone -> Relay (on connect)
{ type: "client_connect", username: string }

// Relay -> Phone
{ type: "client_connected" }
{ type: "client_error", reason: "server_offline" | "unknown_username" }

// 配对后：纯 passthrough，relay 不再检查消息。
// Server 会在收到第一条消息时隐式判断连接已被 client 认领；第一条通常是 SRP init。
```

## 实现阶段

### Phase 1：共享类型

**文件：`packages/shared/src/relay-protocol.ts`**（新增）

```typescript
// Server registration
export interface RelayServerRegister {
  type: "server_register";
  username: string;
  installId: string;
}

export interface RelayServerRegistered {
  type: "server_registered";
}

export interface RelayServerRejected {
  type: "server_rejected";
  reason: "username_taken" | "invalid_username";
}

// Client connection
export interface RelayClientConnect {
  type: "client_connect";
  username: string;
}

export interface RelayClientConnected {
  type: "client_connected";
}

export interface RelayClientError {
  type: "client_error";
  reason: "server_offline" | "unknown_username";
}

// Union types
export type RelayServerMessage = RelayServerRegister;
export type RelayServerResponse = RelayServerRegistered | RelayServerRejected;
export type RelayClientMessage = RelayClientConnect;
export type RelayClientResponse = RelayClientConnected | RelayClientError;

// Type guards
export function isServerRegister(msg: unknown): msg is RelayServerRegister { ... }
export function isClientConnect(msg: unknown): msg is RelayClientConnect { ... }

// Username validation
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export function isValidUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}
```

**文件：`packages/shared/src/index.ts`**：导出新增类型。

**测试：`packages/shared/test/relay-protocol.test.ts`**

- Type guard 正确性
- Username validation：合法、边界和非法用例

---

### Phase 2：Relay Package

**目录：`packages/relay/`**

```text
packages/relay/
├── package.json          # depends on hono, better-sqlite3, @yep-anywhere/shared
├── tsconfig.json
├── src/
│   ├── index.ts          # Hono server entry
│   ├── config.ts         # Environment config (PORT, DATA_DIR)
│   ├── db.ts             # SQLite database setup
│   ├── registry.ts       # UsernameRegistry - SQLite persistence
│   ├── connections.ts    # ConnectionManager - matching & forwarding
│   └── ws-handler.ts     # WebSocket route handler
└── test/
    ├── registry.test.ts
    └── connections.test.ts
```

**Database（`db.ts`）：**

```typescript
import Database from "better-sqlite3";

// Schema
// CREATE TABLE usernames (
//   username TEXT PRIMARY KEY,
//   install_id TEXT NOT NULL,
//   registered_at TEXT NOT NULL,
//   last_seen_at TEXT NOT NULL
// );

export function createDb(dataDir: string): Database.Database { ... }
```

**UsernameRegistry（`registry.ts`）：**

- `canRegister(username, installId)`：如果 username 可用，或属于当前 installId，则返回 true。
- `register(username, installId)`：占用 username，并更新 `last_seen_at`。
- `updateLastSeen(username)`：活动时刷新时间戳。
- `reclaimInactive(days: number)`：删除超过 N 天未活动的记录。

**ConnectionManager（`connections.ts`）：**

```typescript
class ConnectionManager {
  private waiting = new Map<string, WebSocket>();  // username -> waiting connection
  private pairs = new Set<{ server: WebSocket; client: WebSocket }>();

  registerServer(ws: WebSocket, username: string, installId: string):
    "registered" | "username_taken" | "invalid_username";

  connectClient(ws: WebSocket, username: string):
    "connected" | "server_offline" | "unknown_username";

  forward(ws: WebSocket, data: Buffer | string): void;

  handleClose(ws: WebSocket): void;
}
```

- `registerServer`：校验 username 格式，检查 registry；同一个 installId 重连时替换已有 waiting connection。
- `connectClient`：查找 waiting connection，移出 waiting map，创建 pair。
- `forward`：查找配对 socket 并转发数据。
- `handleClose`：从 waiting map 或 pairs set 中移除；如果是已配对连接，则关闭另一端。

**Keepalive（`ws-handler.ts`）：**

- 每 60 秒 ping waiting connection。
- 30 秒内没有 pong 就断开。
- paired connection 不由 relay 做 keepalive。

**回收：**

- 启动时运行 `registry.reclaimInactive(90)`。
- 可选每小时运行一次，v2 再做也可以。

**测试：`packages/relay/test/`**

- `registry.test.ts`：username 占用、相同 installId 替换、不同 installId 拒绝、过期回收
- `connections.test.ts`：server registration、client pairing、forwarding、close cleanup

---

### Phase 3：InstallService（Yepanywhere）

**文件：`packages/server/src/services/InstallService.ts`**（新增）

```typescript
interface InstallState {
  version: number;
  installId: string;    // crypto.randomUUID()
  createdAt: string;
}

class InstallService {
  private state: InstallState;
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "install.json");
    this.state = this.load();
  }

  private load(): InstallState {
    // If file exists and valid, return it
    // Otherwise generate new installId, persist, return
  }

  getInstallId(): string {
    return this.state.installId;
  }
}
```

**文件：`packages/server/src/index.ts`**：启动早期初始化 `InstallService`。

**测试：`packages/server/test/services/InstallService.test.ts`**

- 首次运行生成新 ID
- 持久化并重新加载同一个 ID
- 文件损坏时重新生成

---

### Phase 4：RelayClientService（Yepanywhere）

**文件：`packages/server/src/services/RelayClientService.ts`**（新增）

职责：

- 持久连接 relay，并注册 `username + installId`
- waiting connection 被客户端认领后，把 socket 交给 yepanywhere 现有 WS relay handler
- 立即打开新的 waiting connection
- 断开时用 exponential backoff 重连

核心逻辑：

```typescript
class RelayClientService {
  private waitingWs: WebSocket | null = null;
  private backoff: ExponentialBackoff;
  private relayUrl: string;
  private username: string;
  private installId: string;

  constructor(config: {
    relayUrl: string;
    username: string;
    installId: string;
    onRelayConnection: (ws: WebSocket, firstMessage: string) => void;
  }) {
    this.backoff = new ExponentialBackoff({
      initialDelay: 1000,
      maxDelay: 60_000,
      multiplier: 2
    });
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.relayUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "server_register",
        username: this.username,
        installId: this.installId
      }));
    };

    ws.onmessage = (event) => this.handleMessage(ws, event);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => this.handleClose();
  }
}
```

`handleMessage` 规则：

- 收到 `server_registered`：保存为 waiting connection，重置 backoff。
- 收到 `server_rejected`：记录错误；`username_taken` 是永久错误，不重试。
- 收到其他消息：表示已被远端 client 认领，第一条消息是 SRP init。把 socket 交给 `onRelayConnection`，然后立即再打开一条 waiting connection。

**与 `ws-relay.ts` 集成：**

```typescript
// Existing: handles direct WebSocket connections
app.get("/ws-relay", upgradeWebSocket((c) => { ... }));

// New: accept already-connected WebSocket from relay
export function acceptRelayConnection(ws: WebSocket, firstMessage: string): void {
  const handler = createWsRelayHandler();

  ws.onmessage = (event) => handler.onMessage(event.data);
  ws.onclose = () => handler.onClose();
  ws.onerror = () => handler.onClose();

  handler.onMessage(firstMessage);
}
```

关键点：WebSocket 已经在 relay 侧完成 upgrade，因此这里跳过 Hono 的 `upgradeWebSocket`，直接接入同一套 handler。SRP 和加密流程保持一致。

**测试：`packages/server/test/services/RelayClientService.test.ts`**

- 成功连接和注册
- 处理 `username_taken`
- 第一条消息到达时判定为被认领，完成 handoff 并重连
- 断开后 exponential backoff
- backoff 最大 60 秒

---

### Phase 5：设置界面

**文件：`packages/server/src/remote-access/RemoteAccessService.ts`**

- state 增加 `relayUrl?: string`
- state 增加 `relayUsername?: string`
- 增加 `getRelayConfig()` / `setRelayConfig()`
- schema version 增加并提供 migration

**文件：`packages/server/src/remote-access/routes.ts`**

- `GET /api/remote-access/relay`：获取 relay 配置
- `PUT /api/remote-access/relay`：设置 relay URL 和 username
- `DELETE /api/remote-access/relay`：禁用 relay

**文件：`packages/client/src/pages/SettingsPage.tsx`**

- remote access 启用后显示 relay section
- relay URL 输入框，默认 placeholder 为 `wss://relay.yepanywhere.com/ws`
- relay username 输入框
- 状态指示器：connected、disconnected、error

**文件：`packages/client/src/hooks/useRemoteAccess.ts`**

- state type 增加 `relayConfig`
- 增加 `updateRelayConfig()` / `clearRelayConfig()`

详细 UI 测试可以等核心链路稳定后再补；Phase 6 做基础 E2E 覆盖。

---

### Phase 6：集成测试

**E2E：`packages/relay/test/e2e/relay.e2e.test.ts`**

启动 relay + yepanywhere + 模拟手机客户端，覆盖：

1. **Server registration flow**
   - Server 连接并注册 username
   - 收到 `server_registered`
   - 连接保持打开，作为 waiting connection

2. **Client connection flow**
   - 手机用已注册 username 连接
   - 收到 `client_connected`
   - Server 收到第一条消息（SRP init）

3. **Message forwarding**
   - 手机发送消息，server 能收到
   - Server 发送消息，手机能收到
   - Binary data 正常转发

4. **Server offline**
   - 手机连接未注册 username
   - 收到 `client_error: server_offline`

5. **Username taken**
   - Server A 注册 `alice`
   - Server B 用不同 installId 注册 `alice`
   - Server B 收到 `server_rejected: username_taken`

6. **Same installId replacement**
   - Server 注册 `alice`
   - Server 用相同 installId 重连
   - 新 connection 替换旧 waiting connection

7. **Reconnection after disconnect**
   - Server 注册后连接断开
   - Server 使用 backoff 重连
   - 成功重新注册

8. **Full relay flow**
   - Yepanywhere 连接 relay
   - 手机通过 relay 连接
   - SRP 认证穿过 relay 完成
   - 加密 app traffic 正常工作

---

### Phase 7：Server Wiring ✅

把 `RelayClientService` 真正接入 yepanywhere server。

**状态：已完成**

实现说明：

- `RelayClientService` 在 `index.ts` 中、`createApp` 之前实例化。
- 使用 `relayConfigCallbackHolder` 向 routes 传 callback，避免循环依赖。
- `createAcceptRelayConnection` 在 app 创建后构造 handler。
- 启动时调用 `updateRelayConnection()`，并通过 callback holder 绑定到 API routes。
- `GET /api/remote-access/relay/status` 返回 `{ status, error, reconnectAttempts }`。

**文件：`packages/server/src/index.ts`**

```typescript
import { RelayClientService } from "./services/RelayClientService";

const installService = new InstallService(config.dataDir);
await installService.initialize();

const relayClientService = new RelayClientService();

const acceptRelayConnection = createAcceptRelayConnection({
  app,
  baseUrl,
  supervisor,
  eventBus,
  uploadManager,
  remoteAccessService,
  remoteSessionService,
});

async function updateRelayConnection() {
  const relayConfig = remoteAccessService.getRelayConfig();
  if (relayConfig?.url && relayConfig?.username) {
    await relayClientService.start({
      relayUrl: relayConfig.url,
      username: relayConfig.username,
      installId: installService.getInstallId(),
      onRelayConnection: acceptRelayConnection,
    });
  } else {
    relayClientService.stop();
  }
}

await updateRelayConnection();
```

**文件：`packages/server/src/remote-access/routes.ts`**

- relay 配置变更后调用 `onRelayConfigChanged?.()`。
- 新增 status endpoint：

```typescript
app.get("/api/remote-access/relay/status", (c) => {
  return c.json({
    status: relayClientService.getStatus(),
    error: relayClientService.getLastError(),
  });
});
```

**客户端 UI：**

- 轮询 `/api/remote-access/relay/status`，或改用 SSE。
- `waiting` 显示绿色 Connected。
- `connecting` / `registering` 显示 Connecting。
- `rejected` 显示错误。

**测试：`packages/server/test/integration/relay-wiring.test.ts`**

- 配置存在时 server 启动后连接 relay
- relay 配置变更后重新连接
- relay 配置清空后断开
- status endpoint 返回正确状态

---

### Phase 8：Remote Client Relay Support ✅

在 remote client 中增加 relay 连接模式，同时保留 direct 连接模式。

**状态：已完成**

实现说明：

- `SecureConnection.connectWithExistingSocket()` 接收来自 relay 的已连接 WebSocket。
- `RemoteLoginModePage` 提供模式选择：relay 或 direct。
- `DirectLoginPage` 从旧 `RemoteLoginPage` 改名，处理 direct WebSocket 连接。
- `RelayLoginPage` 处理 relay 连接流程，并显示状态反馈。
- `RemoteConnectionContext.connectViaRelay()` 管理 relay handshake 和 SRP auth。
- `remote-main.tsx` 增加登录路由：`/login`、`/direct`、`/relay`。
- `RemoteApp` 的 `ConnectionGate` 更新为基于路由的认证流。

**连接模式：**

1. **Direct mode**：输入 devserver WebSocket URL + SRP credentials
   - 用于 LAN、Tailscale、未来 Android WebView
   - 示例 URL：`wss://192.168.1.10:3400/ws-relay`

2. **Relay mode**：输入 relay username + SRP credentials
   - 用于 NAT traversal 和公网访问
   - 默认 relay：`wss://remote.yepanywhere.com/ws`

**文件：`packages/client/src/remote-main.tsx`**

```tsx
<Routes>
  <Route path="/" element={<RemoteLoginPage />} />
  <Route path="/direct" element={<DirectLoginPage />} />
  <Route path="/relay" element={<RelayLoginPage />} />
  {/* ... rest of app routes wrapped in RemoteApp ... */}
</Routes>
```

**文件：`packages/client/src/pages/RemoteLoginPage.tsx`**（新增）

模式选择页：

- Connect via Relay -> `/relay`
- Direct Connection -> `/direct`

**文件：`packages/client/src/pages/DirectLoginPage.tsx`**

保留原 direct flow：

- WebSocket URL input
- Username input
- Password input
- Connect button -> `SecureConnection.connect(wsUrl, username, password)`

**文件：`packages/client/src/pages/RelayLoginPage.tsx`**（新增）

Relay flow：

- Relay username 输入框，例如 `crostini`
- SRP username 输入框
- SRP password 输入框
- 可选 relay URL override，默认 `wss://remote.yepanywhere.com/ws`

```typescript
async function connectViaRelay(relayUsername: string, srpUsername: string, srpPassword: string) {
  const relayUrl = customRelayUrl || "wss://remote.yepanywhere.com/ws";

  const ws = new WebSocket(relayUrl);

  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "client_connect", username: relayUsername }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "client_connected") {
        resolve(ws);
      } else if (msg.type === "client_error") {
        reject(new Error(msg.reason));
      }
    };

    ws.onerror = () => reject(new Error("connection_failed"));
  });

  await secureConnection.connectWithExistingSocket(ws, srpUsername, srpPassword);
}
```

**文件：`packages/client/src/lib/SecureConnection.ts`**

新增接受已连接 WebSocket 的方法：

```typescript
async connectWithExistingSocket(ws: WebSocket, username: string, password: string): Promise<void> {
  this.ws = ws;
  this.setupMessageHandler();
  await this.performSrpAuth(username, password);
}
```

**Relay Login UI 状态：**

- Initial：展示输入表单
- Connecting：`Connecting to relay...`
- Waiting：发送 `client_connect` 后显示 `Waiting for server...`
- Error：显示 `server_offline`、`connection_failed` 等错误
- Success：跳转到 app

**测试：`packages/client/test/relay-login.test.ts`**

- Relay 连接成功
- 正确处理 `server_offline`
- 正确处理 `connection_failed`
- Relay 出问题时能优雅失败

---

## 关键文件

| 文件 | 动作 | 阶段 |
|------|------|------|
| `packages/shared/src/relay-protocol.ts` | 新建：协议类型 | 1 |
| `packages/relay/` | 新建：relay package | 2 |
| `packages/relay/src/db.ts` | 新建：SQLite setup | 2 |
| `packages/relay/src/registry.ts` | 新建：username registry | 2 |
| `packages/relay/src/connections.ts` | 新建：connection manager | 2 |
| `packages/server/src/services/InstallService.ts` | 新建：install ID | 3 |
| `packages/server/src/services/RelayClientService.ts` | 新建：relay client | 4 |
| `packages/server/src/remote-access/RemoteAccessService.ts` | 修改：增加 relay config | 5 |
| `packages/server/src/remote-access/routes.ts` | 修改：relay endpoints | 5 |
| `packages/server/src/routes/ws-relay.ts` | 修改：接受 relay connections | 5 |
| `packages/client/src/pages/SettingsPage.tsx` | 修改：relay settings | 5 |
| `packages/client/src/hooks/useRemoteAccess.ts` | 修改：relay config hook | 5 |
| `packages/server/src/index.ts` | 修改：接入 RelayClientService | 7 |
| `packages/server/src/remote-access/routes.ts` | 修改：relay status endpoint | 7 |
| `packages/client/src/pages/RemoteLoginPage.tsx` | 新建：模式选择页 | 8 |
| `packages/client/src/pages/DirectLoginPage.tsx` | 重命名：已有登录页 | 8 |
| `packages/client/src/pages/RelayLoginPage.tsx` | 新建：relay login flow | 8 |
| `packages/client/src/lib/SecureConnection.ts` | 修改：接受已有 WebSocket | 8 |
| `packages/client/src/remote-main.tsx` | 修改：增加登录路由 | 8 |

## 配置

**Relay server：**

- `RELAY_PORT`：默认 `3500`
- `RELAY_DATA_DIR`：默认 `~/.yep-relay/`
- `RELAY_LOG_LEVEL`：默认 `info`

**Yepanywhere server：**

- Relay config 存在 `remote-access.json`
- Install ID 存在 `install.json`

## 设计决策

- **Registry 使用 SQLite**：`better-sqlite3` 支持原子操作，查询也简单。
- **自托管 relay**：在 monorepo 中作为 `packages/relay`。
- **技术栈一致**：Hono + Node.js，与 yepanywhere server 保持一致。
- **不做复杂 auth**：`installId` 是用于 username claim 的弱 secret。
- **Username 先到先得**：90 天未活动后可回收。
- **Username 格式**：`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`，即 3-32 个字符。
- **离线检测**：没有 waiting connection 时，relay 立即返回 `server_offline`。
- **自定义 relay URL**：用户可在设置中指向自己的 relay。
- **哑管道**：Relay 不检查消息内容，端到端加密在 phone 和 yepanywhere 之间完成。
- **隐式认领检测**：Server 收到第一条消息时判定 waiting connection 已被认领。
- **Exponential backoff**：防止 relay/server 重启时出现 thundering herd，最大 60 秒。
- **Keepalive**：Relay 每 60 秒 ping waiting connection，30 秒无 pong 则断开。

## 未来：多 Relay 扩展

需要时增加 front-door service：

1. Yepanywhere 连接 front-door，被分配到 relay N。
2. Phone 查询 front-door 获取 username 所在 relay，然后连接 relay N。
3. 数据库记录 `username -> relay` 映射，并尽量保持 sticky。

这个能力可以以后加入，不需要改变核心 relay 协议。

## 验证

### 本地测试（使用本地 relay）

1. 启动 relay：`cd packages/relay && pnpm dev`，运行在端口 `3500`
2. 启动 yepanywhere：`pnpm dev`，运行在端口 `3400`
3. 在 yepanywhere 中配置 relay：Settings > Remote Access > Relay URL = `ws://localhost:3500/ws`
4. 设置 relay username，例如 `testuser`
5. 启用 remote access，并设置 SRP username/password
6. 确认 Settings 显示 relay status 为绿色 `Connected`
7. 启动 remote client：`pnpm dev:remote`，运行在端口 `3402`
8. 打开 relay login，输入 relay username + SRP credentials
9. 确认 SRP auth 完成，app 能通过 relay 工作

### 生产测试（使用 remote.yepanywhere.com）

1. 启动 yepanywhere：`pnpm start`
2. 配置 relay：Settings > Remote Access > Relay URL = `wss://remote.yepanywhere.com/ws`
3. 设置 relay username
4. 启用 remote access，并设置 SRP username/password
5. 确认 relay status 显示 `Connected`
6. 在手机上打开 `https://remote.yepanywhere.com`
7. 用同一个 relay username + SRP credentials 进行 relay login
8. 确认可以通过公共 relay 连接

### 运行测试

```bash
pnpm --filter @yep-anywhere/relay test
pnpm --filter @yep-anywhere/server test
pnpm test:e2e
```
