# 连接矩阵

本文说明四种连接模式、它们的重连行为，以及目前的测试覆盖。

服务端 WebSocket 认证语义（policy 与 SRP transport state 的区分）见
[`ws-auth-state-model.md`](ws-auth-state-model.md)。

## 连接模式总览

| 模式 | 传输 | 认证 | 使用场景 |
|------|------|------|----------|
| **DirectConnection** | fetch + SSE | Cookies | localhost/LAN 默认模式 |
| **WebSocketConnection** | 单条 WS | Cookies | 开启开发设置时使用 |
| **SecureConnection** | 加密 WS | SRP + NaCl | Remote mode，直连 |
| **SecureConnection + Relay** | 通过 relay 的加密 WS | SRP + NaCl | Remote mode，NAT traversal |

### 选择逻辑

来自 `packages/client/src/hooks/useConnection.ts`：

```text
1. 已设置全局 SecureConnection？-> 使用 SecureConnection（remote mode）
2. developer setting websocketTransportEnabled？-> 使用 WebSocketConnection
3. 默认 -> 使用 DirectConnection
```

## 连接模式细节

### 1. DirectConnection（SSE + fetch）

**文件：**

- Client：`packages/client/src/lib/connection/DirectConnection.ts`
- SSE：`packages/client/src/lib/connection/FetchSSE.ts`

**传输：**

- API calls：原生 `fetch()`，带 credentials。
- Streaming：自定义 `FetchSSE`，不是原生 `EventSource`。
  - 原因：需要检测 HTTP status code（401/403），并控制重连。

**认证：**

- 基于 cookie 的 session，通过 `credentials: "include"` 隐式发送。
- 401/403 会触发 `authEvents.signalLoginRequired()`。

**初始数据加载：**

- Session：REST 调用 `/api/sessions/:id/jsonl` 获取完整历史。
- Live updates：SSE 连接 `/api/sessions/:id/stream`。

**消息流：**

```text
┌─────────────┐     REST /jsonl      ┌─────────────┐
│   Client    │ ──────────────────▶  │   Server    │
│             │                      │             │
│             │     SSE /stream      │             │
│             │ ◀════════════════════│             │
└─────────────┘                      └─────────────┘
```

---

### 2. WebSocketConnection

**文件：**

- Client：`packages/client/src/lib/connection/WebSocketConnection.ts`
- Server：`packages/server/src/routes/ws.ts`

**传输：**

- 所有流量走单条 WebSocket。
- 通过 `{ id, type: "request" }` / `{ id, type: "response" }` multiplex request。

**认证：**

- 基于 cookie；cookie 在 WS upgrade 时发送。

**使用场景：**

- 仅开发设置中使用，用来测试不带加密的 WS protocol。

---

### 3. SecureConnection（加密 WebSocket）

**文件：**

- Client：`packages/client/src/lib/connection/SecureConnection.ts`
- Crypto：`packages/client/src/lib/connection/srp-client.ts`、`nacl-wrapper.ts`
- Server：`packages/server/src/routes/ws-relay.ts`、`ws-relay-handlers.ts`

**传输：**

- 所有消息走单条 WebSocket，并全部加密。
- 加密算法：XSalsa20-Poly1305（NaCl secretbox）。

**认证：**

- SRP-6a 零知识密码证明。
- Session key 由 SRP 派生，永不传输。
- 支持 session resumption，重连时可跳过完整 SRP。

**协议：**

```text
Full SRP Handshake:
  Client                          Server
    │                               │
    │ ── srp_hello (identity) ────▶ │
    │ ◀── srp_challenge (salt, B) ──│
    │ ── srp_proof (A, M1) ───────▶ │
    │ ◀── srp_verify (M2, sessionId)│
    │                               │
    │   [session key K established] │
    │                               │
    │ ══ encrypted traffic ════════▶│

Session Resume (stored session):
  Client                          Server
    │                               │
    │ ── srp_resume ──────────────▶ │  (sessionId + encrypted timestamp)
    │ ◀── srp_resumed ─────────────│  (or srp_invalid -> fall back to full SRP)
    │                               │
    │ ══ encrypted traffic ════════▶│
```

---

### 4. SecureConnection + Relay

**额外文件：**

- Client context：`packages/client/src/contexts/RemoteConnectionContext.tsx`
- Relay server：`packages/relay/src/`

**使用场景：**

- 通过公共 relay 做远程访问，用于 NAT traversal。

**流程：**

```text
┌──────────┐    ┌───────────┐    ┌─────────────┐
│  Phone   │───▶│   Relay   │◀───│ Yepanywhere │
│          │    │           │    │   Server    │
│ SRP+NaCl │    │ opaque    │    │ SRP+NaCl    │
│          │    │ blobs     │    │             │
└──────────┘    └───────────┘    └─────────────┘
```

Relay 只能看到加密数据块。SRP handshake 会穿过 relay，到 yepanywhere server 完成。

---

## 重连行为

### 触发点

| 触发 | 说明 |
|------|------|
| 网络断开 | WebSocket close，SSE error |
| 设备休眠 | 笔记本合盖、手机息屏 |
| 页面可见性变化 | Tab hidden 超过 5 秒 |
| 服务器重启 | 连接带 close code 关闭 |

### 各模式重连

#### DirectConnection（SSE）

| 事件 | 行为 |
|------|------|
| SSE error | `FetchSSE` 2 秒后自动重连 |
| SSE close | `FetchSSE` 2 秒后自动重连 |
| 401/403 | 停止重连，发出 login required |
| Reconnect | `connected` event 触发带 `?afterMessageId` 的 `fetchNewMessages()` |

**注意：** SSE 的 `lastEventId` 当前被忽略，但 JSONL incremental fetch 会补齐漏掉的消息。

#### WebSocketConnection

| 事件 | 行为 |
|------|------|
| WS close | 下一次 request 触发 `ensureConnected()` |
| Max retries | 1 秒间隔重试 3 次 |
| Pending requests | 以 `WebSocketCloseError` reject |
| Subscriptions | 通过 `onClose()` callback 通知 |

#### SecureConnection（Direct + Relay）

| 事件 | 行为 |
|------|------|
| WS close | `ensureConnected()` 尝试重连 |
| 已存 session | 优先尝试 `srp_resume` |
| Session invalid | 回落到完整 SRP |
| Relay mode | 使用 `reconnectThroughRelay()` |
| Relay failure | 抛出 `RelayReconnectRequiredError` |

**移动端唤醒处理**（`useRemoteActivityBusConnection.ts:40-57`）：

- 监听 `document.visibilitychange`。
- hidden 超过 5 秒后调用 `forceReconnect()`。
- 强制关闭 WebSocket 并完整重连。
- 通知所有 subscriptions 重新订阅。

---

## 重连后的数据同步

### Session Messages

**初次加载页面：**

1. REST 调用 `/api/sessions/:id` 加载完整 JSONL 历史。
2. SSE 连接 `/api/sessions/:id/stream`。
3. Client 在 REST 加载完成前暂存 SSE messages。
4. 使用 `getMessageId()` 做重复检测并合并。

**SSE 重连时（笔记本唤醒、网络恢复）：**

1. SSE 自动重连，默认 2 秒后重试。
2. Server 发送 `connected` event。
3. Client 调用 `fetchNewMessages()`，带 `?afterMessageId=<lastKnownId>`（`useSession.ts:774`）。
4. Server 只返回该 ID 之后的消息（`reader.ts:201-207`）。
5. Client 用 `mergeJSONLMessages()` 合并新消息。
6. SSE 也会 replay 内存 buffer，通常是最近 30-60 秒 SDK messages。
7. 重复检测保证不会产生重复消息。

**关键代码：**

- `lastMessageIdRef` 跟踪最后已知 message ID（`useSessionMessages.ts:112`）。
- `fetchNewMessages()` 使用 incremental API（`useSessionMessages.ts:294-320`）。
- 所有 readers 都实现了 server `afterMessageId`：`reader.ts`、`gemini-reader.ts` 等。
- 单元测试：`packages/server/test/incremental-session.test.ts`。

**示例：**

```text
1. 打开 session，看到 10 条消息 -> lastMessageIdRef = msg10.id
2. 合上笔记本
3. 另一台电脑新增 100 条消息
4. 打开笔记本
5. SSE 重连，触发 "connected" event
6. fetchNewMessages() 请求 ?afterMessageId=msg10
7. Server 返回 messages 11-110
8. Client 现在拥有全部 110 条消息
```

### Activity Events

**当前流程：**

- 不做历史同步；订阅之后只接收新事件。
- Visibility change 会触发 `forceReconnect()` 并重新订阅。

**缺口：** 如果离线 N 秒，这段时间内的 session status changes 可能会漏掉。

---

## Session Persistence

| 模式 | 存储内容 | 位置 | 目的 |
|------|----------|------|------|
| DirectConnection | Browser profile ID | localStorage | 关联多个 tab |
| WebSocketConnection | 无 | - | Stateless |
| SecureConnection | Session key、URL、username | localStorage | 刷新后跳过 SRP |
| SecureConnection + Relay | 另加 relay URL、relay username | localStorage | 通过 relay 重连 |

**Stored session format：**

```typescript
interface StoredSession {
  wsUrl: string;
  username: string;
  sessionId: string;
  sessionKey: string;  // Base64-encoded 32 bytes
}
```

---

## 当前缺口

### 1. SSE stream 未实现 `lastEventId`（影响低）

**状态：** 未实现

**影响：** 低

**位置：** `packages/server/src/routes/stream.ts`

SSE stream 会忽略 `?lastEventId=X` 参数。但实际影响有限：

- SDK messages 每 30-60 秒清空一次，有两个 clearing bucket。
- JSONL incremental fetch 已通过 `?afterMessageId=X` 实现。
- 重连时 client 会拉取漏掉的 JSONL messages，SSE 也会 replay buffer。
- 对现实中的离线时间来说，这足够覆盖。

### 2. Activity stream 没有 catch-up

**状态：** 未实现

**影响：** 中等，离线期间可能漏掉 status changes。

重连后，client 只能看到新的 activity events。如果断线期间 session status 变了，client 可能一直显示旧状态，直到下一次更新。

**Workaround：** client 可以在重连时刷新 session list。

### 3. 重连时丢失 in-flight requests

**状态：** 符合当前设计

**影响：** 中等

WebSocket 关闭时：

- Pending requests 以 `WebSocketCloseError` reject。
- Client 必须在应用层重试。
- 不自动排队或 replay requests。

### 4. 缺少重连 + incremental fetch 的 E2E

**状态：** 测试缺口

**影响：** 中等；功能可用，但缺少回归测试。

JSONL incremental fetch 已有单元测试（`incremental-session.test.ts`），但还没有 browser E2E 模拟：

1. 连接 session，看到 messages。
2. 断开连接，模拟 laptop close。
3. 离线期间追加 messages 到 JSONL。
4. 重连。
5. 验证所有 messages 都被 fetch 回来。

这类测试应该补上，用来防止完整重连链路回归。

---

## E2E 测试覆盖

### 已测试

| 场景 | 模式 | 测试文件 |
|------|------|----------|
| 基础 WS request/response | WebSocket | `ws-transport.e2e.test.ts` |
| WS event subscriptions | WebSocket | `ws-transport.e2e.test.ts` |
| WS file uploads | WebSocket | `ws-transport.e2e.test.ts` |
| SRP handshake | Secure WS | `ws-secure.e2e.test.ts` |
| 加密流量 | Secure WS | `ws-secure.e2e.test.ts` |
| 刷新后 session resume | Relay | `relay-integration.spec.ts` |
| 错误密码 | Relay | `relay-integration.spec.ts` |
| Relay message forwarding | Relay | `relay.e2e.test.ts` |

### 未测试

| 场景 | 缺口 |
|------|------|
| SSE transport | 完全没有 SSE E2E |
| Reconnection + incremental fetch | 功能可用，但没有 E2E 回归测试 |
| 网络中断模拟 | 只测试了 graceful disconnect |
| 设备 sleep / wake recovery | 未模拟 |
| 长连接 | 没有 duration tests |
| 多 tab 协调 | 未测试 |
| 部分消息恢复 | 未测试 |

### 建议新增测试

1. **Reconnection + incremental message fetch**（高优先级）
   - 连接 session，收到 N 条消息。
   - 模拟断开连接，关闭 SSE/WS。
   - 离线期间向 JSONL 追加消息。
   - 重连。
   - 验证 client 通过 `?afterMessageId` 收到所有消息。

2. **SSE basic flow**
   - 连接、接收 events、验证顺序。

3. **Visibility change**
   - 模拟 tab hidden/visible，验证重连。

4. **Concurrent reconnection**
   - 多个 subscription 同时重连。

---

## 关键代码位置

### Client Connection Layer

```text
packages/client/src/lib/connection/
├── DirectConnection.ts      # SSE + fetch
├── WebSocketConnection.ts   # WS protocol
├── SecureConnection.ts      # SRP + encryption
├── FetchSSE.ts              # Custom SSE implementation
├── srp-client.ts            # SRP-6a client
├── nacl-wrapper.ts          # NaCl encryption
└── types.ts                 # Connection interface
```

### Hooks

```text
packages/client/src/hooks/
├── useConnection.ts         # Mode selection
├── useSSE.ts                # SSE subscription logic
└── useSessionMessages.ts    # Message merging/buffering
```

### Server Streaming

```text
packages/server/src/routes/
├── stream.ts                # SSE endpoint
├── activity.ts              # Activity SSE
├── ws.ts                    # Unencrypted WS
├── ws-relay.ts              # Encrypted WS endpoint
└── ws-relay-handlers.ts     # SRP + message handling
```

---

## 参见

- [Relay Design](relay-design.md)：详细 relay 协议和实现
- [Remote Access](remote-access.md)：面向用户的远程访问选项
