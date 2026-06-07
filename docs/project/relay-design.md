# Relay 系统设计

**状态：** 草案

**作者：** 2026-01-10 设计讨论

## 总览

Relay service 让手机客户端可以连接到 NAT 后面的 yepanywhere server，不再依赖 Tailscale、Cloudflare Tunnel 或端口转发。

### 目标

1. **零配置远程访问**：用户只设置 username/password，就能从任意浏览器连接。
2. **端到端加密**：Relay 不能读取用户流量，认证使用 SRP，加密使用 NaCl。
3. **简单配对**：不强制扫码；QR code 可以作为后续优化。
4. **可扩展**：通过 config endpoint 发现 relay，未来可从自托管迁移到托管服务。

### 初始非目标

- 移动 App；当前先做 Web。
- UPnP hole punching；后续可优化。
- 多 relay region；先从单 region 开始。

## 架构

```text
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Phone/Browser  │────▶│     Relay       │◀────│   Yepanywhere   │
│                 │     │                 │     │                 │
│  - SRP auth     │     │  - Routes msgs  │     │  - Holds SRP    │
│  - Encrypts     │     │  - Cannot read  │     │    verifier     │
│    traffic      │     │    traffic      │     │  - Decrypts     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌─────────────────┐
                        │ Config Endpoint │
                        │ (yepanywhere.com│
                        │  /api/config)   │
                        └─────────────────┘
```

## 组件

### 1. Config Endpoint（yepanywhere.com）

返回 relay URL 和版本要求。这样以后迁移 relay 时，不需要更新客户端。

```json
{
  "relay": {
    "servers": [
      { "url": "wss://relay.yepanywhere.com", "region": "us" }
    ],
    "minVersion": "0.3.0",
    "maxVersion": null
  }
}
```

Yepanywhere server 启动时拉取该配置；当前已有版本信息拉取流程，可复用。

### 2. Relay

Relay 是轻量 WebSocket router。

职责：

- 接受 yepanywhere server connection，并用 secret/注册信息认证。
- 接受 phone connection；SRP handshake 穿过 relay，由 yepanywhere server 完成验证。
- 在 phone 和 yepanywhere server 之间转发加密消息。
- 跟踪 yepanywhere server 当前连在哪个 relay，便于未来多 relay 扩展。

Relay 不做这些事：

- 不读取消息内容；所有 app traffic 都端到端加密。
- 不存用户数据。
- 不处理 SRP verifier；verifier 存在用户自己的 yepanywhere server 上。

### 3. Yepanywhere Server 变更

- **Relay client**：到 relay 的持久 WebSocket connection。
- **SRP verifier storage**：在 data dir 存储 username、salt、verifier。
- **Settings UI**：启用 remote access，设置 username/password。
- **Connection handler**：处理 relay protocol messages，解密后转给现有 handlers。

### 4. Client（Phone/Browser）变更

- **Connection abstraction**：抽象 Direct 和 Relay 模式。
- **SRP client**：通过 relay 向 yepanywhere server 认证。
- **Encryption layer**：加密/解密全部流量。
- **Relay protocol**：在单个 WebSocket 上复用 HTTP request、event stream、upload 等能力。

## 用户流程

### 一次性配置

1. 用户打开 yepanywhere settings。
2. 启用 Remote Access。
3. 输入 username，例如 `kgraehl`，并检查可用性。
4. 输入 password。
5. Yepanywhere server 存储 SRP verifier，不存 password。
6. Yepanywhere server 连接 relay，并注册 username。

### 手机连接

1. 用户访问 `yepanywhere.com/c/kgraehl`。
2. 输入 password。
3. 通过 relay 完成 SRP handshake，证明双方都知道 password。
4. 建立 session key。
5. 所有 traffic 使用 session key 加密。
6. 手机保存派生 key，用于后续自动重连。

## 协议细节

### SRP 认证

使用 SRP-6a + SHA-256。Yepanywhere server 只存 verifier，不存 password。

```text
Phone                      Relay                      Yepanywhere
  │                          │                          │
  │ ── SRP hello (A) ──────▶ │ ── forward ───────────▶ │
  │                          │                          │
  │ ◀── SRP challenge (B) ── │ ◀── forward ─────────── │
  │                          │                          │
  │ ── SRP proof (M1) ─────▶ │ ── forward ───────────▶ │
  │                          │                          │
  │ ◀── SRP verify (M2) ──── │ ◀── forward ─────────── │
  │                          │                          │
  │    (session key K established, relay cannot derive K)
  │                          │                          │
  │ ══ encrypted traffic ══▶ │ ══ passthrough ═══════▶ │
```

### 消息加密

使用 NaCl secretbox（XSalsa20-Poly1305）：

- 每条消息使用 24-byte random nonce。
- Session key 来自 SRP。
- 使用 authenticated encryption，篡改可检测。

### Relay Protocol（加密 payload）

所有 app-level 消息都放在加密 envelope 内。

```typescript
// HTTP-like request/response
{ type: "request", id: "uuid", method: "GET", path: "/api/sessions", body?: any }
{ type: "response", id: "uuid", status: 200, body: any }

// Event streaming (replaces SSE)
{ type: "subscribe", sessionId: "..." }
{ type: "event", sessionId: "...", eventType: "message", data: any }

// File uploads
{ type: "upload_start", uploadId: "...", filename: "...", size: 1234 }
{ type: "upload_chunk", uploadId: "...", offset: 0, data: "base64..." }
{ type: "upload_complete", uploadId: "...", file: {...} }
```

### Client Connection Abstraction

```typescript
interface Connection {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  subscribe(sessionId: string): AsyncIterable<SessionEvent>;
  upload(file: File, onProgress: (n: number) => void): Promise<UploadedFile>;
}

// Plain mode - normal fetch, WebSocket, SSE (localhost dev, easy debugging)
class DirectConnection implements Connection { ... }

// Secure mode - SRP + encrypted WebSocket (reusable base)
class SecureConnection implements Connection {
  constructor(wsUrl: string, username: string) { ... }
  async connect(password: string) { /* SRP handshake, derive sessionKey */ }
  // All methods encrypt/decrypt using sessionKey
}

// Direct secure - WS straight to yepanywhere (LAN testing)
new SecureConnection("wss://192.168.1.50:3400/ws", "kgraehl")

// Via relay - WS to relay (production remote access)
new SecureConnection("wss://relay.yepanywhere.com/ws", "kgraehl")
```

**连接模式：**

| 模式 | 传输 | 认证 | 用途 |
|------|------|------|------|
| DirectConnection | fetch/WS/SSE | Cookie session | localhost 默认模式，方便 Network tab 调试 |
| WebSocketConnection | WS to yepanywhere | Cookie session | 开发设置，用来测试 WS protocol，不加密 |
| SecureConnection (direct) | WS to yepanywhere | SRP + encryption | LAN，测试 secure protocol 但不经过 relay |
| SecureConnection (relay) | WS to relay | SRP + encryption | 生产远程访问 |

**模式选择：**

- localhost/LAN 默认使用 `DirectConnection`，仍走普通 fetch/XHR/SSE。
- `WebSocketConnection` 通过 developer settings toggle 启用，用于测试。
- 通过 relay URL 连接时自动使用 `SecureConnection`。

`SecureConnection` 扩展 `WebSocketConnection`，只是在同一套 WS protocol 和 message routing 外面增加 SRP handshake 和 encryption layer。

## 多 Relay 扩展

未来做多 relay load balancing 时：

1. **Registration**：Yepanywhere server 注册到中心数据库（Redis/Postgres）。
2. **Discovery**：Phone 查询 `kgraehl` 在哪里，拿到 relay URL。
3. **Routing**：Phone 连接正确的 relay。

```text
Phone ──▶ /api/relay/locate/kgraehl ──▶ { "relay": "wss://relay2.yepanywhere.com" }
      │
      └──▶ connect to relay2
```

这样可以通过指示 yepanywhere server 重连到不同 relay 来实现 rebalance。

## 安全考虑

### Relay 能看到

- 正在连接的 username
- 连接时间和持续时长
- 加密数据块大小，因此存在 traffic analysis 可能

### Relay 看不到

- Password；SRP 是 zero-knowledge
- Session key；key 由 password 派生，永不传输
- 消息内容；已加密
- 上传文件内容；已加密

### 加密前压缩（2026-02-21 已评审）

- Relay payload 可以在加密前 gzip 压缩，以改善大响应的带宽和延迟。
- 如果攻击者可控输入和 secret 出现在同一个压缩 payload 中，并且攻击者能反复观察 ciphertext length，理论上可能出现 CRIME/BREACH 类 length-oracle 攻击。
- 当前架构接受该风险为低：relay traffic 是认证后的端到端加密；每条消息独立 gzip，没有跨消息共享压缩上下文；当前也没有已知高风险 secret-reflection response 类型。
- 如果威胁模型变化，应保留压缩，并对敏感消息类型增加 ciphertext length bucketing/padding，而不是全局关闭压缩。

### 滥用防护

- 限制 registration 频率：每 IP 每小时 3 次。
- 限制 SRP attempts，防止暴力破解。
- Username blocklist，过滤冒犯性词汇。
- 回收长期未活动 username，例如 90 天。

## 推送通知

推送通知和 relay 是独立问题。有两种选择：

**方案 A：通用通知**

```json
{ "title": "kgraehl", "body": "Action needed" }
```

用户点击后，app 再通过加密 relay 拉取详情。

**方案 B：用户可选**

设置中允许用户选择显示完整详情（隐私较弱）或通用提示（隐私更强）。

## 实现阶段状态

### Phase 1：Protocol Types

在 `packages/shared/src/relay.ts` 中定义 request/response、subscription、upload 和 union types。

```typescript
type RelayRequest = {
  type: "request";
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type RelayResponse = {
  type: "response";
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};
```

任务：

- [x] 在 shared package 中定义类型
- [x] 从 `shared/index.ts` 导出

### Phase 2：Connection Interface + WebSocket Transport

- [x] 定义 `Connection` interface。
- [x] `DirectConnection` 包装现有 fetch。
- [x] `useConnection` hook 返回 `DirectConnection`。
- [x] `/ws` endpoint 支持 request/response。
- [x] `WebSocketConnection.fetch()` 根据 ID 匹配 response。
- [x] Developer settings 增加 `Use WebSocket transport` toggle，默认关闭。
- [x] 支持 event subscription，替代 SSE。
- [x] 支持 file upload。
- [ ] 全量切换 app 到 `WebSocketConnection`。
- [ ] localhost 上做完整 E2E。
- [ ] 补齐重连、错误、超时等边界情况。

### Phase 3：SRP + Encryption

- [x] SRP helpers：生成 verifier、client/server handshake。
- [x] NaCl encryption helpers：secretbox wrapper。
- [x] SRP + encryption 单元测试。
- [x] `/ws` endpoint 增加 SRP handshake。
- [x] `WebSocketConnection` 增加 encryption layer，形成 `SecureConnection`。
- [x] SRP verifier 存储到 data dir。
- [x] Settings UI 支持 remote access username/password setup。

### Phase 3.5：Direct Secure 静态站点测试

在加入 relay 复杂度前，先用 GitHub Pages 托管的 client 直接连接 yepanywhere server，验证完整 secure connection flow。

已完成：

- [x] `remote.html` entrypoint 和 `remote-main.tsx`
- [x] `vite.config.remote.ts`
- [x] `pnpm build:remote` / `pnpm dev:remote`
- [x] GitHub Actions 部署 `dist-remote/` 到 GitHub Pages
- [x] 独立登录页 `RemoteLoginPage.tsx`
- [x] WebSocket URL、username、password 表单
- [x] 通过 `SecureConnection` 完成 SRP handshake
- [x] 登录成功后用 `SecureConnection` 渲染主应用

待验证：

- [ ] localhost remote client -> localhost yepanywhere
- [ ] LAN 测试，例如 `ws://192.168.1.50:3400/ws`
- [ ] 服务端设置页生成 QR code
- [ ] 静态站点登录页扫码连接

### Phase 3.6：Remote Login 浏览器 E2E

目标：用 Playwright 启动 remote client，并执行真实登录流程。

已完成：

- [x] E2E test server 使用自动分配端口
- [x] test helpers：`configureRemoteAccess()` / `disableRemoteAccess()`
- [x] fixtures：`maintenanceURL`、`wsURL`、`remoteClientURL`
- [x] remote client dev server 在 global setup 中启动
- [x] CORS 允许 remote client origin
- [x] `RemoteLoginPage` 增加 data-testid
- [x] 登录页渲染、成功登录、错误密码、未知用户、server unreachable、空字段校验
- [x] SecureConnection 下 sidebar navigation、activity subscription、mock project 可见

待补：

- [ ] 创建 session、发送消息并验证 streaming，需要更多 UI instrumentation
- [ ] 通过 encrypted WebSocket 上传文件，需要更多 UI instrumentation

### Phase 3.7：Session Resumption

问题：SRP 派生出的 session key 只存在内存中。刷新页面、URL 导航或浏览器重启后，需要重新输入密码。

方案：本地保存 session key，并增加 session resumption protocol。有效 session 存在时跳过完整 SRP handshake。

协议：

```typescript
type SrpSessionResume = {
  type: "srp_resume";
  identity: string;
  sessionId: string;
  proof: string;
};

type SrpSessionResumed = {
  type: "srp_resumed";
  sessionId: string;
};

type SrpSessionInvalid = {
  type: "srp_invalid";
  reason: "expired" | "unknown" | "invalid_proof";
};
```

安全取舍：

- Session key 存在 localStorage，同 origin JS 可访问；这是便利性和安全性的权衡。
- Proof 使用 session key 加密当前 timestamp，降低 replay 风险；server 要校验 timestamp 在 5 分钟内。
- 改密码会让所有 session 失效，并应提供 `sign out everywhere`。
- 每个用户最多 5 个 active sessions，新认证会淘汰最旧 session。

状态：

- [x] 协议类型和 type guards
- [x] server session storage service
- [x] `ws-relay.ts` 处理 `srp_resume`
- [x] 启动和定期清理过期 session
- [x] 改密码时让 session 失效
- [x] client 存储 `sessionId` 和 `sessionKey`
- [x] `SecureConnection.fromStoredSession()`
- [x] `connectAndAuthenticate()` 先尝试 resume，失败再回落 SRP
- [x] login form 增加 `Remember me`
- [ ] session storage service 单元测试
- [ ] E2E：登录后刷新仍保持认证
- [ ] E2E：session 过期触发重新登录
- [ ] E2E：改密码后 session 失效

### Phase 4：Relay

- [ ] 独立 relay package/service
- [ ] 接受 yepanywhere server connection
- [ ] 接受 phone connection，透传 SRP 到 yepanywhere server
- [ ] 转发加密消息
- [ ] 连接跟踪：`username -> socket`
- [ ] 重连处理

### Phase 5：Production

- [ ] yepanywhere server 中的 relay client 启动时连接 relay
- [ ] yepanywhere.com config endpoint
- [ ] 部署 relay
- [ ] 必要时支持多 relay
- [ ] monitoring/alerting

## 待确认问题

1. **Username format**：是否允许 dots/dashes？最小和最大长度？
2. **Password requirements**：最低熵要求？是否给 passphrase 建议？
3. **Session persistence**：手机端缓存 session key 多久？见 Phase 3.7：7 天 idle、30 天 max。
4. **Conflict handling**：yepanywhere server 换机器时是否 last-write-wins？
5. **Offline indicator**：如何区分 `yepanywhere offline` 和 `wrong password`？

## 考虑过的替代方案

### QR Code Pairing

- 优点：不依赖密码，可使用高熵 key。
- 缺点：需要摄像头，第二台设备配置不方便。
- 决策：保留为可选优化，主流程先 password-first。

### FCM/Push for Wake-up

- 优点：不需要持久连接。
- 缺点：FCM 更偏 client 场景，不适合 desktop/server application。
- 决策：yepanywhere server 通常常驻，使用持久 WebSocket 足够。

### Direct WebRTC

- 优点：真正 P2P，不消耗 relay bandwidth。
- 缺点：NAT traversal 复杂，而且最终仍可能需要 TURN。
- 决策：Relay 更简单，且流量较轻。

## 参考资料

- [SRP Protocol](http://srp.stanford.edu/design.html)
- [TweetNaCl.js](https://tweetnacl.js.org/)
- [tssrp6a](https://github.com/midonet/tssrp6a)：TypeScript SRP-6a 实现，当前选型

### SRP Library Choice：tssrp6a

评估过的选项：

- **tssrp6a**（选用）：零依赖、原生 TypeScript、默认 SHA-512，支持 session serialization，适合 stateless HTTP/WS。
- `secure-remote-password`：API 更简单，但 7 年未维护，且只有 JavaScript。
- `thinbus-srp-npm`：更复杂，主要面向 Java backend interop。
- `mozilla/node-srp`：Node-only，crypto pattern 较旧。

关键因素：

- 支持 session serialization；relay protocol 很需要。
- 仍在维护，目前版本为 v3.0.0。
- 零依赖，bundle 更小。
- 原生 TypeScript types。

注意事项：

- 需要 HTTPS/WSS，因为会使用 WebCrypto `Crypto.subtle`。
- 默认配置不把 user identity 纳入 verifier；这允许不重置密码就改 username。如需严格 RFC compliance，可以自定义配置。
