# 远程打开 session 慢：链路梳理与优化计划（2026-10-22）

> 方法：顺着 [项目地图 F2](../project-map/flows.md#f2打开会话接实时输出断线后恢复显示) 做代码审阅，并对运行中的 `8022` 做只读 GET 测量。没有重启任何服务，也没有修改 frpc 配置。
> 被测运行时：build `2026.10.0-d150e67c1e57-20261022024108`，`basePath=/yep`，`runtimeMode=external`。web 进程启动 7–13 分钟时 RSS 为 1.1–1.5 GiB，runtime 进程 160 MiB。
> 前置文档：[性能瓶颈审计（2026-08-24）](./2026-08-24-performance-bottleneck-audit.md)、[穿透链路审计（2026-09-03）](./2026-09-03-remote-tunnel-latency-audit.md)、[展示生命周期重构（2026-09-07）](./2026-09-07-session-display-lifecycle-redesign.md)、[代码审计（2026-10-15）](./2026-10-15-code-audit-performance-correctness-redundancy.md)。
> 本文只记录这些文档之后的新发现，不重复已经落地的条目。

## 0. 结论

1. **服务端热读已经不慢。** 已缓存的 session，`display/view` 只要 1–11 ms。经公网隧道（本机 → frps → 本机）为 90–200 ms。冷读期间以 50 ms 间隔并发探测 `/api/version`，p90 为 5.7 ms，max 为 54 ms，事件循环没有被长时间阻塞。
2. **体感慢主要出在冷路径上。** 服务端展示 entry 在最后一个查看者离开 30 s 后就被丢弃。之后再打开，冷读要 0.5–1.75 s。Cursor 会话还有一段随 runtime journal 总量线性增长的全量扫描。
3. **远程会放大三类开销**：首屏 snapshot 传两份、重连时多次重取、PWA 冷启动的串行加载。另有一个后台轮询缺陷（P1-4）。

## 1. 打开 session 的实际链路

客户端入口是 `SessionPage` → `useSession` → `useSessionMessages`。默认路径为 projected，即 `useProjectedSessionMessages`。挂载时并行发起以下请求：

| 请求 | 来源 | 说明 |
| --- | --- | --- |
| `GET .../metadata` | `fetchSessionMetadata` | 缺少 contextUsage 时再请求 `context-status` |
| `GET .../display/view` | `loadSnapshot` | 409 STALE 时最多重试 2 次 |
| `GET .../display/questions`（循环） | 问题目录 | 每页 100 条，**串行翻完所有页** |
| WS `subscribe session + display` | `useSessionStream` | 服务端 `SessionDisplayService.subscribe` **会再推一份完整 `display-snapshot`** |
| `GET /api/project/:id`、`/providers`、`/agents`、skills 等 | SessionPage 其他 hook | 与正文无依赖，但会占用 HTTP/1.1 连接 |

服务端 `display/view` 的处理链：`SessionDisplayService.snapshot` → `get(selection)`。

- entry 不存在时执行 `initialize`：
  - 有进程时先 `getProcessForSession` + `subscribeSession`；
  - 然后 `refresh(force)`，即 `source.stamp` → `source.read`（resolve + 读历史 + normalize）→ reducer `restore` → `snapshot`；
  - Cursor 还要执行 `recoverCursorHistory`。
- entry 有效期由 `retentionMs ?? 30_000` 控制，即无监听者 30 s 后 `drop`。`maxEntries` 为 16。

## 2. 实测数据（2026-10-22，本机 8022）

| 请求 | 冷 | 热 | gzip 后 / 原始大小 |
| --- | ---: | ---: | ---: |
| Cursor `display/view`（3 个会话） | **1.25 / 1.50 / 1.75 s** | 2–11 ms | 32–56 KB / 130–240 KB |
| 同一 Cursor 会话的旧详情接口 | `pageRead` 127 ms，`augment` 52 ms | – | – |
| Codex `display/view`（18 MB rollout） | **487 ms** | 7 ms | 83 KB |
| Codex（小会话） | 28–54 ms | 1 ms | 4–7 KB |
| Pi `display/view`（292 条消息） | 35 ms | 3 ms | 61 KB / 285 KB |
| mcode `display/view` | 27 ms | 2 ms | 7 KB |
| `/display/questions` | 8–92 ms | – | 0.2–1 KB |
| `/metadata` | 4–350 ms | – | 约 1 KB |
| `/api/providers` | **3.4 s** | 15–30 ms | 2.7 KB |
| `/files` | 545 ms | – | 3.9 KB |
| 经隧道 `display/view`（Pi，热） | – | 93–203 ms | 61 KB |

Pi 会话 snapshot 的组成：549 个节点，其中 5 个 question、217 个 thinking、134 个 assistant_text、193 个 tool_group。thinking 全文约 45 KB，`renderedHtml` 与 `content` 两份正文共约 38 KB。同一个 id 在 `node.id`、`segment.id`、`detailRef` 中重复三次。

## 3. 新发现的瓶颈

### P0-1　Cursor 冷开额外约 1.1 s：runtime journal 全量扫描

- 调用点：`SessionDisplayService.recoverCursorHistory` 和 `reasoning`，均调用 `runtime.replay({ sessionId, allProcesses: true })`。
- 实现：`RuntimeEventStore.findProcessIdsForSession` 遍历 `runtime/events/` 下所有 `.jsonl`/`.jsonl.1` 文件，**整文件读入并逐行 JSON.parse**，只为了找出该 session 用过的 processId。`findLatestProcessIdForSession` 也是同样做法，`subscribeSession` 在无进程时会走到这里。
- 现场体量：130 个文件、222 MB、15.3 万条记录、84 个 session。用只读脚本复现同样的扫描耗时 **1113 ms**，与 Cursor 冷开多出的时间吻合。
- 影响：
  - 耗时随 journal 总量线性增长；保留策略为 7 天 / 512 MB，上限远高于当前体量。
  - external 形态下扫描在 runtime 进程执行，会和活跃 turn 抢 CPU。
- 方向：维护 `sessionId → processId[]` 索引（append 时更新，启动时扫描一次，或用 sidecar 文件持久化），replay 只读相关进程的文件。
- 部署档位：`runtime/` 属于 runtime 档，会中断活跃 turn，应等空闲时正常部署。

### P0-2　展示 entry 30 s 过期，冷读代价高

- 切到别的 session 超过 30 s 后再切回，或手机锁屏后重连，服务端都要冷读。客户端有 5 条 SWR 缓存，能先显示旧内容，但会一直处于"同步中"，直到冷读完成。
- Codex 冷读：`readThread` + `listTurns(limit=40)` + 每个 turn 执行 `readAllTurnItems`（`itemsView: full`，并发 4）。完整的命令输出被拉回服务端后只用来生成摘要；另外还要读 `semanticRevision` 两次、`supplementInterAgentMessages`。
- Cursor 冷读：`DatabaseSync` 读 `store.db` 并遍历 protobuf，再叠加 P0-1。
- 方向：
  1. `drop` 时保留紧凑 snapshot + stamp，按总字节数做 LRU。重开时如果 stamp 未变，直接复用，不必重新读历史。
  2. Codex 只对最新的活跃 turn 取 full items，历史 turn 取 summary。需对照 `references/codex/` 确认 summary 视图字段是否足够生成工具组摘要。

### P1-1　首屏 snapshot 传两份

- HTTP `display/view` 和 WS 订阅时服务端推送的 `display-snapshot` 是同一个 entry 的同一份 snapshot。大会话每份 60–83 KB（gzip），客户端各做一次 `SessionDisplaySnapshotSchema.parse`。
- 方向：WS 订阅时携带客户端已有的 `epoch/seq`，服务端只发 patch 或"无变化"确认；或者 WS 已连接时客户端跳过 HTTP 冷读。

### P1-2　重连 / 切回前台时重复取数

- `handleActivityReconnect` 会调用 `fetchPersistedSessionChanges`（projected 下即 metadata + display/view）和 `getSessionMetadata`；WS 重新订阅又推一份 snapshot。服务端 entry 若已过期，还要再冷读一次。
- `ConnectionManager` 的 `pongTimeoutMs` 默认仍为 2000 ms（2026-09-03 审计 P4-1 未处理）。

### P1-3　PWA 冷启动是串行瀑布

- 加载顺序：`index.html` → 入口 JS（`index` 93 KB br + vendor 81 KB br + CSS 41 KB br）→ 路由懒加载 `SessionPage` chunk（**124 KB br，原始 538 KB**，9 月为 459 KB）→ 才开始请求 API。
- `public/sw.js` 只有 navigation 处理器，没有静态资源预缓存。`DisplaySnapshotCache` 只存在内存里，重开 PWA 后清空。
- `zh-CN` 语言包在挂载后异步加载（43 KB br），首帧会先显示英文。
- 方向：入口脚本按 URL 提前发起 metadata 和 display/view 请求；session 路由加 modulepreload；SW 预缓存 hash 资源；最近 1–2 个 snapshot 存入 IndexedDB。

### P1-4　后台轮询，以及一个确认的缺陷

- `useReloadNotifications`：external 形态下每 2 s 调用一次 `syncFromServer`，即 `/dev/status` + `/status/workers`，不判断 `document.hidden`。
- **缺陷**：生产环境没有 `/api/dev/status` 路由，请求落到 SPA fallback，返回 `200 text/html`，客户端 JSON 解析失败后被静默吞掉。由此推断，任何未知的 `/api/*` 路径都会返回 HTML 而不是 404。
- 方向：未匹配的 `/api/*` 返回 JSON 404；客户端在生产环境不轮询 `/dev/status`；页面隐藏时暂停轮询。

### P2　小项

- snapshot 冗余：thinking 全文（默认折叠，可以只给预览，展开时通过已有的 `reasoning` 接口取）、`renderedHtml` 与 `content` 两份、id 重复三次。
- `/api/*` 只用 gzip 压缩（Hono `compress`），brotli 约能再小 10–15%。
- questions 每次打开都串行翻完所有页。
- `/api/providers` 冷启动 3.4 s（CLI 探测），期间占住一条 HTTP/1.1 连接，输入框能力也晚到。
- mcode store 同样在主线程同步执行 `DatabaseSync`；体量小，暂未见阻塞。
- web 进程 RSS 1.1–1.5 GiB，尚未归因。需要 heap snapshot，要动进程，需授权。

### 已排除或不是主因

- 事件循环阻塞：冷读期间探针 max 54 ms。
- 热读延迟：1–11 ms。
- 隧道 RTT：约 20–40 ms。
- `SessionIndexService mode=full`：每次约 360 ms，几分钟一次。日志量大，但不是打开 session 时的主因。

## 4. 实施计划

| 步骤 | 内容 | 档位 | 状态 |
| --- | --- | --- | --- |
| 1 | **观测**：`display/view` 输出分阶段 Server-Timing；冷初始化较慢时记录结构化日志；客户端记录从路由开始到首屏内容出现的耗时 | shell + client | 已部署（`a7a57dcc7` + 工作树） |
| 2 | P0-1 runtime journal 按 session 建索引 | runtime | 已部署（build `…-20261022040520`） |
| 3 | P0-2 保留紧凑 snapshot（休眠缓存）；Codex 历史 turn 只取 summary 暂缓 | shell | 休眠缓存已部署并验证 |
| 3b | P0-3 `resolve` 慢：项目快照允许使用旧版本、runtimeState 去重、子阶段打点 | shell | 已部署（build `…-20261022062911`） |
| 3c | P0-3 重启场景：持久化项目快照作为首次扫描前的种子 | shell | 已部署并验证 |
| 4 | P1-1 / P1-2 订阅去重、重连收敛、放宽 pong 超时 | shell + client | 待做 |
| 5 | P1-3 / P1-4 冷启动预取、SW 预缓存、轮询修复、`/api` 返回 404 | client + shell | 待做 |
| 6 | P2 按需处理 | – | 待做 |

每一步完成后，用第 1 步的指标做前后对比，结果追加到下文"落地记录"。

## 5. 未验证的部分

- 没有使用真机或浏览器测量首屏时间；客户端渲染和 Zod 解析成本是根据代码推断的。
- 隧道测量是从本机绕回本机，不代表手机所在网络。
- P0-1 的耗时是用等价脚本复现的，没有直接调用 runtime 控制端口（需要 token）。
- 内存占用没有归因。

## 6. 落地记录

### 步骤 1：观测（2026-10-22，已实现，未部署）

服务端：

- `packages/server/src/display/display-timing.ts`（新增）：固定的阶段名 `wait / attach / resolve / stamp / read / reduce / replay / total`，以及缓存状态 `hit / miss / wait`。
- `SessionDisplayService`：
  - `snapshot` / `older` 接受可选的 `SessionDisplayReadObserver`。
  - `get` 区分三种情况：新建 entry 为 `miss`；初始化尚未完成为 `wait`，只记等待时长；已就绪为 `hit`。
  - 冷初始化的阶段耗时只计入发起初始化的那个请求。HTTP 与 WS 同时打开时，不会把同一次读取计两遍。
  - `refresh` 中 reducer 部分拆成 `applySourcePage`，计入 `reduce`。
- `createSessionDisplaySource`：`resolve`（含 runtime 状态）、`stamp`（文件统计 / summary）、`read`（历史读取 + normalize）分开计时。`read` 内部调用的 stamp/resolve 不会重复计入 `read`。
- `display/view` 路由在成功和错误响应中都输出 `Server-Timing`，末尾附加 `displayCache;desc=<state>`。header 只含时长和固定标记。
- 冷初始化达到 500 ms 或失败时，写一条 `event: "session_display_cold_read"` 日志，字段为 provider、durationMs、phases、nodeCount、attachedProcess、failed、errorCode。HTTP 和 WS 触发的冷读都会记录。阈值可通过构造参数 `slowInitializeMs` 调整。

客户端：

- `packages/client/src/lib/sessionLoadTiming.ts`（新增）：`SessionLoadTracer`。每次打开 session/branch 只输出一行 `[SessionLoad] {...}`，字段为 appUptimeMs、cached、transport、freshMs/freshSource、viewMs/viewStatus/viewServerTiming、metadataMs、timedOut。切走时丢弃该次记录；30 s 上限到达后输出部分结果。Server-Timing 只保留格式合法的 token 和数值。
- `api.getSessionDisplayView` 增加可选的 `onResponse`，用于获取状态码和 `server-timing` header；不传时行为不变。
- `useProjectedSessionMessages` 在加载开始、metadata 完成、HTTP view 完成、首个新 snapshot（HTTP 或 WS）安装时打点。

数据去向：

- 服务端：`~/.yep-anywhere/logs/server.log` 或 launchd stdout，用 `grep session_display_cold_read` 查看。
- 客户端：开启 Developer Mode 远程日志后，在 `~/.yep-anywhere/logs/client-logs/*.jsonl` 中查找 `[SessionLoad]`。
- 也可以直接 `curl -D -` 查看 `display/view` 的 `Server-Timing` header。

验证：`pnpm lint`、`pnpm typecheck` 通过；`pnpm test` 中 shared 514、client 1508、server 4329 个用例通过，2 个为原本就跳过的用例。新增测试：

- `test/display/display-timing.test.ts`：miss/wait/hit 状态、阶段归属、慢读日志、失败日志、阶段累加。
- `test/routes/session-display.test.ts`：Server-Timing header 内容，不泄露 session id，错误响应也带 header。
- `src/lib/__tests__/sessionLoadTiming.test.ts`：tracer 的完成条件、跨 session 隔离、超时上限、header 压缩。

部署说明：本步骤属于 client + shell 档。`pnpm hot-apply --check` 报告 runtime 档，原因是部署时的工作树是 dirty 的，差异基线包含了当时未提交的 `supervisor/`、`codex-model-proxy/`、`cursor.ts` 等文件，与本步骤无关。因此没有执行叠加，由用户重新部署（build `2026.10.0-a7a57dcc71ae-20261022032143`）。

#### 部署后基线（2026-10-22 03:25，本机只读 GET）

稳态冷读（`displayCache=miss`），单位 ms：

| provider | total | resolve | read | reduce | replay |
| --- | ---: | ---: | ---: | ---: | ---: |
| cursor ×2 | 989 / 1024 | 4 / 12 | 27 / 54 | 1 / 3 | **955 / 955** |
| codex ×3 | 21–144 | 4–8 | 15–137 | 1–6 | 0 |
| pi ×2 | 7–22 | 4–9 | 1–8 | 1–3 | 0 |
| mcode ×3 | 20–30 | 9–13 | 4–8 | 1–5 | 0 |

缓存命中时 total 为 0.1–0.9 ms。

重启后客户端同时重连（03:23，来自 `session_display_cold_read` 日志）：

| provider | total | resolve | read | replay |
| --- | ---: | ---: | ---: | ---: |
| pi | 3416 | 3364 | 19 | 0 |
| codex | 4557 | 3592 | 902 | 0 |
| cursor ×3 | 7214–7468 | 3391–3514 | 608–713 | 3064–3196 |

结论：

- 证实 P0-1：Cursor 冷开的 96% 耗时是 `replay`。重启重连时 3 个会话各自全量扫描，每个涨到约 3.1 s。
- **新发现 P0-3**：服务重启后第一批打开的 `resolve` 约 3.4 s，所有 provider 都受影响。推断是 project scanner / 跨 provider summary 查找的冷启动，与启动期的其它扫描争抢。待用新打点进一步拆分，列入后续步骤。

### 步骤 2：runtime journal 按 session 索引（2026-10-22，已实现，未部署）

- `packages/server/src/runtime/RuntimeEventSessionIndex.ts`（新增）：按文件增量维护 `sessionId → processId → 最新 {seq, timestamp}`。
  - 每个文件记录 inode 和已消费偏移，偏移始终停在完整行末尾。
  - 查询时只做 `readdir + stat`：文件未变就复用；仅追加则只读尾部；inode 变化或文件变小就重扫；文件被 prune 删除就移出索引。
  - store 自己轮转时调用 `moved()` 把摘要迁到 `.1` 路径，避免重扫 10 MB 文件。
  - 刷新不会重叠。刷新进行中到达的查询，全部共享一次后续刷新，保证能看到查询前已完成的追加。
  - 快速解析：`append` 序列化时把 `seq/timestamp/processId/sessionId` 写在 `data` 之前，只对行首 1 KB 做 UTF-8 解码和正则匹配。以下情况回退到完整 `JSON.parse`：行内还有第二个记录起始标记（中断的残行与下一条记录拼接）、字段顺序不同、前缀不匹配。不以 `}` 结尾的行直接丢弃。由此与旧实现（`parseRecords`）对坏行的处理保持一致。
- `RuntimeEventStore`：`findProcessIdsForSession` 和 `findLatestProcessIdForSession` 改走索引，对外接口和 `replay` 语义不变；新增 `warmSessionIndex()`。`runtime/standalone.ts`（external）和 `createEmbeddedRuntimeEventStore`（embedded）在创建 store 后都会在后台预热。

本机只读基准（真实 `runtime/events/`：133 个文件、266 MB、16.2 万行、85 个 session）：

| 项 | 旧实现 | 新实现 |
| --- | ---: | ---: |
| 单次查询 | 786–825 ms | **1.4–1.6 ms** |
| 3 个并发查询 | 3 次全量扫描 | 2.7 ms |
| 冷建索引（每个 runtime 进程一次，启动时后台完成） | – | 700 ms → 加快速解析后 **234 ms** |

全部 85 个 session 的进程集合和最新进程选择，与旧的全量扫描结果逐一一致（0 处不一致）。预期：Cursor 稳态冷开从约 1000 ms 降到约 50 ms；重启重连时 `replay` 从约 3.1 s 降到不超过一次预热（约 0.24 s）。部署后用步骤 1 的 Server-Timing 复测。

验证：`pnpm lint`、`pnpm typecheck` 通过；server 4342 个用例通过，2 个为原本就跳过的用例。新增 `test/runtime/RuntimeEventSessionIndex.test.ts`（13 个用例）：

- 增量读取的字节数；
- 尾部残行等它补齐后再计入；
- 跨 1 MB 读取块的大行和多字节字符；
- inode 替换、文件截断、prune 删除；
- 轮转后不重扫；
- 最新进程的选择规则；
- 并发查询共享后续刷新；
- 目录不存在；
- 快速解析（转义字符、字段顺序不同时回退、非法身份）；
- 拼接残行被拒绝；
- store 级别跨轮转与新进程的 `replay`。

部署档位：runtime（`src/runtime/`），会中断活跃 turn，应在空闲时走正常部署。`app.ts` 的改动只影响 embedded 形态。

#### 步骤 2 部署后复测（2026-10-22 04:06 部署）

- 稳态 Cursor 冷开（6 个会话）：total **27–200 ms**，`replay` 12–148 ms。部署前同一时段（03:42–04:02）为 1.2–2.8 s，`replay` 1.1–2.7 s，期间 journal 仍在增长。剩余的 `replay` 来自读取该会话自身进程的 journal 文件。
- 重启重连（04:06:39）：Cursor 的 `replay` 为 0.2–0.6 s（索引正在冷建，与启动期其他工作并发）。但这次 `resolve` 达到 **7.4–8.2 s**，Codex 会话同样如此，P0-3 成为重启时的主因。

### 步骤 3b：`resolve` 慢（P0-3）（2026-10-22，已实现，未部署）

调查：

- 稳态下 `/api/projects` 的 `projectLookup` 大多是 0.2 ms，但每隔几秒会出现一次 **277–345 ms**，即一次完整的项目扫描。
- 用只读脚本单测各 provider 扫描器：冷读时 Codex 361 ms，其余合计约 80 ms；缓存命中时都在 1 ms 以内。
- 生产环境的 Codex 扫描器走 `CodexSessionCatalog`。它的 TTL 为 2 s，并且 `app.ts` 在**每个 Codex `file-change` 事件**上都会调用 `codexSessionCatalog.invalidate()`。rollout 每追加一次就触发一次。快照过期后，下一个调用方要同步等待：经 app-server 分页拉完整个 `thread/list`，再 `stat` 所有 rollout 路径并补标题。
- 结果：只要有任何 Codex 会话在运行，项目快照几乎总是过期状态；打开会话时 `resolve` 中的项目查找就可能要等约 0.3 s。重启时还要叠加 app-server 子进程启动，以及与启动期其他扫描的竞争。
- 同一次冷读中，`getRuntimeState` 被调用 4–5 次：`refresh.stamp`→resolve；缓存未命中时 resolve 内部和返回前各一次；`read`→resolve；`read`→stamp→resolve。external 形态下每次都经 HTTP 到 runtime 查进程快照，再查 bridge 视图和待输入。
- 另外记录但暂不处理：每个 Codex 文件事件也会删除 rollout manifest 缓存，下次使用时由 worker 全量重扫头部（约 361 ms，不在主线程）。

改动：

- `ProjectScanner.getOrCreateProject(id, provider, { allowStale })`：项目在上一份快照中，且快照不超过 60 s 时，直接返回并在后台刷新；否则走原来的同步路径。只有 display 解析路径启用，项目列表等调用方行为不变。
- `resolveDisplaySession`：先用旧快照查找；如果会话找不到（例如旧快照缺少刚出现的 provider 标记），用最新快照重试一次。
- `createSessionDisplaySource`：缓存未命中时直接复用刚解析出的 runtime 状态；`read` 只解析一次，stamp 基于同一个结果计算。每次冷读 `getRuntimeState` 从 4–5 次降为 2 次：`refresh` 中的 stamp 一次，`read` 一次。
- Server-Timing 增加 `resolve` 的子阶段 `project / runtimeState / summary`，部署后可以直接看出剩余耗时在哪一段。

验证：`pnpm lint`、`pnpm typecheck` 通过；`pnpm test` 中 shared 514、client 1508、server 4346 个用例通过，2 个为原本就跳过的用例。新增：

- 扫描器：后台扫描阻塞时仍立即返回已知项目；未知项目走同步扫描；快照新鲜时不触发扫描。
- 路由：旧快照找不到会话时用最新快照重试；冷读只查询一次 runtime 状态。

部署档位：shell（`projects/scanner.ts`、`routes/session-display.ts`、`display/display-timing.ts`）。`pnpm hot-apply --check` 仍报告 runtime 档，原因是已部署的 commit 仍为 `a7a57dcc7`，步骤 1 和 2 尚未提交，它们的 runtime 文件仍在差异中，尽管这些改动实际已经部署。提交并完成一次正常部署后，hot-apply 的基线会恢复正常。

#### 步骤 3b 部署后复测（2026-10-22 06:30 部署）

稳态冷读（`displayCache=miss`，8 个会话）：`project` **0.0–0.1 ms**（此前可达约 300 ms），`runtimeState` 1.4–5.6 ms，total 4–143 ms。剩余较大的一段是个别会话的 `summary`（45–68 ms，SessionIndex 校验）和 Cursor `stamp`（约 58 ms）。

重启重连（06:30:22–27，服务 06:30:19 开始监听）：

| provider | total | project | runtimeState | summary | read | replay |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| pi | 4080 | 3487 | 133 | 0 | 389 | 0 |
| codex | 3616 | 2641 | 170 | 8 | 695 | 0 |
| cursor ×3 | 3864–4786 | 2710–3481 | 471–490 | 39–60 | 236–244 | 275–447 |

结论：重启后进程内还没有任何项目快照，旧快照路径无法生效，所有请求都在等首次扫描（2.6–3.5 s，与启动期 Codex app-server、manifest worker 等并发）。总耗时从 7.4–8.9 s 降到 3.6–4.8 s，主要得益于 runtimeState 去重和 replay 索引。

### 步骤 3c：持久化项目快照（2026-10-22，已实现，未部署）

- `ProjectScanner` 新增 `snapshotCachePath` 选项，`app.ts` 在有 dataDir 时设为 `<dataDir>/indexes/project-snapshot.json`。
- 每次扫描完成后在后台原子写入（`atomicWriteText`）。项目集合不变时最多每小时重写一次，只用于刷新 `savedAt`。
- 启动时异步加载为种子，只在**首次扫描完成前**、且仅对 `allowStale` 查询生效，有效期 24 h。会话找不到时会用最新快照重试（步骤 3b 的保护），所以种子过期或缺项不会造成 404。首次扫描完成后种子即被丢弃。`getProject` 等需要最新数据的查询从不使用种子。
- 损坏、版本不符或过期的种子直接忽略，退回原来的扫描路径。

预期：重启后首批打开会话的 `project` 从 2.6–3.5 s 降到毫秒级，total 降到约 0.5–1 s，剩下的是 `read` 与 `runtimeState` 在启动期的竞争。

验证：`pnpm lint`、`pnpm typecheck` 通过；`pnpm test` 中 shared 514、client 1508、server 4348 个用例通过，2 个为原本就跳过的用例。新增：

- 种子在"重启"后、首次扫描阻塞时仍能返回已知项目；
- 新鲜查询不使用种子；
- 损坏、版本不符、过期的种子被忽略。

### 其他发现（记录，待查）

- `server-launchd.out.log` 中较早的日期出现过持续数小时的循环：每 2 s 一次 `[WS] Unhandled error in routeMessage (type=subscribe ...): Error: Session not found`，紧接着 `Client disconnected/connected`，约 30 次/分钟。客户端对一个已不存在的会话反复订阅 display，且似乎每次都导致整条 WS 重连，连带影响同一连接上的其他订阅。今天没有复现。属于步骤 4（重连收敛）的范围，届时一并处理：订阅错误应返回 404 响应而不是断开连接，客户端遇到 404 时停止重试。

#### 步骤 3c 部署说明（2026-10-22 06:41 部署）

这次重启不能用来验证种子：种子文件是在扫描完成后才写入的（mtime 06:42），重启前运行的版本还没有这段代码，所以本次启动时没有可用的种子。本次重启时 `project` 为 5.96–6.87 s，total 7.3–8.3 s，Codex 的 `read` 为 1.9 s。种子文件已正常生成（25 个项目），需要在下一次重启时验证。

### 步骤 3：休眠缓存（P0-2）（2026-10-22，已实现，未部署）

- `SessionDisplayService`：
  - entry 过期（无监听者 `retentionMs`，默认 30 s）或因 `maxEntries` 被挤出时调用 `sleep()`，不再直接 `drop()`。
  - 只有已稳定的历史视图才会转入休眠：没有 runtime 订阅、没有正在进行的初始化或刷新、存在 snapshot 和 stamp，且 activity 为 `completed / interrupted / failed / unknown`。其余情况照旧丢弃。
  - 休眠时停止定时器和订阅，释放工具详情缓存（之后从历史按需重新读取），只保留投影。
  - 休眠缓存按 LRU 管理，上限为数量 32、估算字节 64 MiB（snapshot JSON 长度 ×2）。
- 再次打开时调用 `revive()`：并行检查 `source.stamp` 和 `getProcessForSession`。stamp 未变且没有进程时，直接恢复视图，view epoch 和 seq 都不变，客户端缓存可以无缝接上后续增量。否则执行 `reset()`，换新 epoch 后完整冷初始化。并发打开同一会话时共用一次恢复。
- 正确性依据：stamp 包含会话文件的 mtime/size、runtime 的 `toolsMayBeActive` 和 pending input id。休眠期间如果有进程运行，就会改写原生文件或在恢复时被进程检查发现；会话正在运行时根本不会进入休眠。
- `displayCache` 新增 `revived` 状态。

预期：切到别的会话超过 30 s 再切回已结束的会话时，从 20–150 ms（Cursor 曾达 1 s 以上）的冷读，降到一次 stamp 检查，约 1–5 ms，且不读取历史。

暂缓：P0-2 第二部分"Codex 历史 turn 只取 summary"。需要先对照 `references/codex/` 确认 `itemsView: summary` 的字段是否足够生成工具组摘要。而且现在冷读次数已经大幅减少，收益下降，后续视需要再做。

验证：`pnpm lint`、`pnpm typecheck` 通过；`pnpm test` 中 shared 514、client 1508、server 4355 个用例通过，2 个为原本就跳过的用例。新增 `test/display/SessionDisplayDormancy.test.ts`（7 个用例）：

- 已稳定视图恢复时不读历史，且 epoch/seq 不变；
- stamp 变化时换新 epoch 重读；
- 休眠期间启动了进程时冷初始化；
- 运行中的视图和持有实时订阅的视图不进入休眠；
- 数量上限、字节上限和关闭开关；
- 并发打开共用一次恢复。

### 步骤 3c / 3 部署后验证（2026-10-22 06:53，build `…-20261022065211`）

重启重连（服务 06:53:39 开始监听，种子文件由上一次运行写入）：

| provider | total | project | runtimeState | read | replay |
| --- | ---: | ---: | ---: | ---: | ---: |
| cursor ×2 | 626 / 781 | 0 | 67 / 79 | 356 / 370 | 153 / 311 |
| codex | 714 | 0 | 70 | 590 | 0 |

首批打开会话从 7.3–8.3 s（06:41 重启，当时没有种子）降到 **0.63–0.78 s**，`project` 为 0。剩余主要是启动期的 `read`。

休眠缓存：对 4 个 provider 的已结束会话各打开一次（冷读 14–107 ms），等待 33 s 后再打开，全部返回 `displayCache=revived`，total 为 cursor 9.6 ms、pi 9.1 ms、codex 4.4 ms、mcode 20.3 ms，不读取历史。mcode 的耗时主要花在 stamp 检查上。

## 7. 提交记录（2026-10-22）

| commit | 内容 | 对应步骤 |
| --- | --- | --- |
| `95cb161b0` | feat(display): 记录会话打开的分阶段耗时 | 1 |
| `2d908c9c4` | perf(runtime): 按会话增量索引 runtime 事件日志 | 2 |
| `5d2be1c2c` | perf(display): 打开会话时不再等待项目重扫 | 3b |
| `dbf216d3d` | perf(projects): 持久化项目快照供重启后首次扫描前使用 | 3c |
| `5273586bf` | perf(display): 已结束的会话视图过期后休眠复用 | 3 |

每个提交都在"HEAD + 该提交暂存内容"的隔离工作树上（其余改动临时 stash）跑过 `pnpm lint`、`pnpm typecheck` 和相关测试。全部提交之后，工作树与提交前逐字节一致。

## 8. 当前总览

| 场景 | 优化前 | 现在 |
| --- | ---: | ---: |
| Cursor 冷开（稳态） | 1.0–2.8 s | 27–200 ms |
| 切回已结束会话（>30 s 后） | 冷读 20 ms–2.8 s | 4–20 ms（revived） |
| 打开会话时的项目查找 | 偶发约 300 ms | 0–0.1 ms |
| 服务重启后首批打开会话 | 3.4–8.9 s | 0.63–0.78 s |

下一步：步骤 4（订阅去重、重连收敛、订阅错误不再断开整条 WS），然后是步骤 5（客户端冷启动预取与 SW 预缓存、后台轮询修复、`/api` 未匹配路由返回 404）。
