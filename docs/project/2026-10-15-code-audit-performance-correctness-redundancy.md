# 代码审计：性能、正确性与冗余（2026-10-15）

> 初始方法：基于源码的审计，基线为 `main` @ `514784cc3`，版本 `2026.9.0`。
> 状态复核：2026-10-15，功能修复基线为 `1a91ad3a6`，后续测试修复见第 6 节。下文分别标明已修复、已排除和待验证事项。
> 范围：`packages/server`、`packages/client`、`packages/shared` 的相关路径；不代表逐文件完成全库审核。
> 验证：C1、C2、C4 的相关 6 个测试文件共 166 个用例通过，全仓类型检查、变更文件 Biome 和字体检查通过；这些结果不等于全量 CI 或真实交互验收。未进行浏览器验证，未操作运行中的服务。

## 当前状态

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| C1 索引缓存丢失状态字段 | 已修复 | `e0860077d`，全量校验缓存命中复用 `cachedToSummary` |
| C2 流式消息确认绕过历史保护、遗漏清理 | 已修复 | `a5484cbfb`，统一到 `confirmPendingMessage` |
| C3 Gemini ACP 尾部通知排空 | 待验证 | 循环条件差异仍在，但内层已有排空；需证明具体到达时序 |
| C4 本地模型失败状态被成功结果覆盖 | 已修复 | `1a91ad3a6`，显式结果状态及 8 个回归用例 |
| C5 启动失败后的进程清理 | 源码支持的风险，待复现 | 失败路径仍仅发送终止信号；尚未复现持锁孤儿 |
| C6 pending/deferred row key 碰撞 | 已排除（原报告误判） | 构造行时已分配独立 key |
| 飞书 fallback 每条消息查询用量 | 已排除该表述 | 已有 `fallbackUntilMs` 和 `usageRead` 去重 |

状态为“已修复”表示代码已提交并推送，不表示已部署到运行中的服务。

## 0. 总体判断与校准

现有实现已经包含索引缓存、消息投影、流式增量处理、出站背压和进程组清理等机制。审计需要检查具体调用路径是否使用这些机制，不能仅凭局部代码缺少缓存或 helper 就断言缺陷。

本次复核保留有源码依据的风险，撤回 C6 等误报，并把未测量的性能收益、尚未证明的时序问题和类型分层差异标为待验证。下文未特别注明的旧行号对应初始基线；定位时以文件和符号名为准。

---

## 1. 正确性问题与复核结果

### C1 索引缓存命中丢失状态和 fork 字段（已修复）

初始基线中，`packages/server/src/indexes/SessionIndexService.ts` 的全量校验缓存命中分支手写了另一份 `CachedSessionSummary → SessionSummary` 投影，遗漏 `lastTurnStatus`、`lastErrorMessage`、`interrupted` 和 `forkParentSessionId`。

`e0860077d` 已将该分支改为调用 `cachedToSummary`，与其他索引读取路径共用字段映射。`SessionIndexService.test.ts` 新增失败、中断两种状态的回归用例：先读取 summary，再以相同文件 stats 触发全量校验，确认四类字段保留且 reader 只调用一次。

该问题已从待办移除；原报告中的“线上标记闪失”是源码推导的可能表现，并未做线上复现。

### C2 流式确认绕过历史保护并遗漏提交记录清理（已修复）

初始基线中，`useSession.ts` 在 provider 不回显 `tempId` 时自行按内容删除 pending，绕过了 `usePendingMessages.ts` 的时间戳及提交时可见消息身份保护，也没有在这条路径清理 `visibleAtSubmission`。后续 HTTP 回调是否清理该记录取决于调用路径，因此不能笼统断言每条消息都永久泄漏。

`a5484cbfb` 新增并使用 `confirmPendingMessage`，统一流式与快照确认的匹配规则，并在确认时释放对应提交记录：

- 非空 `tempId` 只确认同一提交，避免误清除另一条相同文本的消息。
- 无 `tempId` 时使用消息身份、时间戳和内容匹配，防止已知历史消息误确认新提交。
- 单条流式回显最多确认一个 pending；子 agent/sidechain 流式消息不进入主会话确认路径。

`usePendingMessages.test.tsx` 覆盖身份匹配和提交记录释放；`useProjectedSessionMessages.test.ts` 通过真实 `useSession` 回调覆盖历史回放与新回显。未声称解决所有缺失身份或时间戳的 provider 消息歧义。

### C3 Gemini ACP 尾部通知排空（待验证）

`gemini-acp.ts:643` 的排空循环条件：

```ts
while (!signal.aborted && !promptDone) {
```

同仓库 `kimi.ts` 显式考虑队列中剩余通知，并附有说明性注释：

```ts
// A terminal tool update is commonly queued immediately before the prompt
// response resolves. Drain those already-received notifications so the
// final result is not lost at the turn boundary.
while (!signal.aborted && (!promptDone || updateQueue.length > 0)) {
```

**复核**：Gemini ACP 在外层循环内部已有 `while (updateQueue.length > 0)` 排空，并在退出后刷新文本缓冲。因此，仅比较外层条件不足以证明通知丢失。需构造 prompt 完成、通知入队、generator 暂停/恢复的具体时序，确认是否存在队列非空却退出的可达路径。

**后续**：先补可复现证据，再决定是否调整循环条件；当前不标记为已验证缺陷，也不计入已修复事项。

### C4 本地模型失败状态被成功结果覆盖（已修复）

初始基线中，`codex-oss.ts` 在 `turn.failed` 后仍发出不含 `turnStatus` / `is_error` 的 `result`，`SessionDisplayReducer` 会据此将当前回合关闭为成功。

`1a91ad3a6` 已跟踪本回合失败状态，并综合 CLI 退出码和用户 abort 生成结果：失败为 `failed` / `is_error: true`，用户中断为 `interrupted`，正常完成为 `completed`。后续显式 `turn.completed` 可清除已恢复错误；新回合重新初始化失败标记。退出事件监听也已提前注册，避免消费方处理最后一条消息时 CLI 已关闭而错过 `close`。

`test/sdk/providers/codex-oss.test.ts` 的 8 个用例经真实 readline、provider 转换及 `SessionDisplayReducer` 验证失败、异常退出、恢复、用户中断和关闭竞态。只模拟子进程边界，没有启动真实模型服务；未逐一验证所有其他结果消费者。

### C5 app-server 启动失败后的进程清理（待验证风险）

`CodexBridgeService.ts:3760-3764` 的 spawn 失败路径用裸 `process.kill()`，**只发 SIGTERM、无 SIGKILL 升级、不等 exit**。该 child 在非 Windows 上使用 detached 进程组，可能在父进程退出后继续存活。正常停止路径使用 `terminateProcessGroup`，两条路径的清理策略不同。

而 `:3811-3812` 的注释恰好说明：rollout 锁**只在进程 exit 时释放**。若 app-server 已持锁且忽略 SIGTERM，未等待退出可能遗留持锁子进程；此触发组合尚未实测。

**后续**：复现启动超时及子进程忽略 SIGTERM 的路径，再统一清理策略。`stopManagedUpstreamState` 在 `terminateProcessGroup` 后还会等待 exit；不能仅替换 helper 就宣称 rollout 锁已释放。当前尚未修改此路径，也未操作运行中的服务。

### C6 pending/deferred row key 碰撞（已排除）

原报告只看了 `getRowKey` 的 `row.kind` 回退，没有检查 `buildMessageRows` 的构造逻辑，结论不成立。

`packages/client/src/components/messageRows.ts` 已为 pending 行设置 `key: pending.tempId`，为 deferred 行优先使用 `deferred.tempId`，缺失时使用包含 index 的 `deferred-` 前缀 key。`load-older`、`load-newer`、`compacting` 和 `processing` 才使用 kind 回退，并且各自至多构造一行。

`components/__tests__/messageRows.test.ts` 已覆盖 deferred key 回退和完整行列表 key 唯一性。C6 是审计误报，不是新修复；无需为它修改实现。

### 其他待验证或待处理事项

- **消息身份规则存在差异**：`pagination.ts` 与 `display-projection.ts` 对空字符串 UUID 的处理不同。需确认真实 provider 输入是否可达，再统一规则，避免把不同投影语义强行合并。
- **退出竞态定时器可清理得更及时**：`Process.abort()` 的 5 秒 timeout 在 `_exitPromise` 提前完成后未清理；`bucketSwapTimer` 也未 `unref()`，但已有停止路径。可能延长无其他活跃 handle 时的退出等待；未做退出耗时实测，不将添加 `unref()` 描述为零风险修复。
- **账号配置同步读取**：`readCodexAccountProfiles()` 使用同步读文件及 JSON 解析。需先测量调用频率和文件规模，再决定是否缓存，并保留配置变更可见性。
- **external 启动快照字段差异**：`index.ts` 的 `configuredRuntimeController` 分支在首次发布 `process-state-changed` 快照时未带 `retryStatus`；`runtime/control-server.ts` 的快照带该字段。原文将前者称为 embedded 路径不准确。尚需追踪后续事件是否补全及客户端消费，不能直接断言切换 runtime 会丢失重试状态。

---

## 2. 性能

### 2.1 客户端 display 更新成本（静态分析，未测量）

`preprocessMessagesCache.ts` 已有流式尾部增量缓存。是否仍为瓶颈取决于命中率和实际负载，不能仅凭存在缓存排除。

默认 display 路径存在以下重复计算风险。未使用 `startTransition` 等 API 不能证明客户端完全没有批处理或节流；下表描述单次相关更新的源码成本，不代表每个浏览器帧都会执行：

| 步骤 | 复杂度 | 位置 | 备注 |
| --- | --- | --- | --- |
| `install()` → `setMessages` | **O(M×N)** | `useProjectedSessionMessages.ts:127-139` | 可先测量 |
| `buildSessionDisplayRenderItems` | O(items)，全量新对象 | `lib/sessionDisplay.ts:83-128` | |
| `sessionDisplaySnapshotPage` | O(nodes)，遍历投影节点 | `useProjectedSessionMessages.ts:474` | |
| `usePendingMessages` effect | O(P×M) | `usePendingMessages.ts:138` | 被上一条放大 |

**`install()` 的重复分配（源码已核对）**：

```ts
setMessages((current) =>
  current.filter((message) => !next.nodes.some((node) => ...)),
);
```

`Array.filter` **即使一个元素都没过滤掉也返回新数组**。当一次 patch 安装走到该更新路径时：

- `messages` 引用必然改变 → `SessionPage.tsx:1975` 的 `useMemo`、`usePendingMessages` 的 effect 可能随引用变化重跑；
- 每个 message 都要遍历一次 `next.nodes`（双层循环）。

**修法**：`let changed = false` 手动循环，只在真的过滤掉元素时返回新数组。收益需通过 profiler 或可比基准测量，原报告的“一半成本”没有测量依据，撤回。

`buildSessionDisplayRenderItems` 每次调用会新建 item 对象，可能削弱 `RenderItemComponent` 的浅比较缓存。实际渲染范围还受虚拟化、父组件更新及其他 props 影响；应先测量，再考虑保持未变化项引用，明确缓存失效和内存上限。

连带两个衍生问题：

- `memo(MessageList)`（`MessageList.tsx:213`）在 `SessionStreamPanes` 重渲染并创建新的内联 `onCancelDeferred` 时无法靠浅比较跳过。可测量后稳定回调，不据此建议直接删除 memo。
- `SessionMetadataContext` 的 value 是内联对象字面量（`contexts/SessionMetadataContext.tsx:22-24`），无 `useMemo` → provider 重渲染时会改变 value 引用，可能触发消费者重渲染。

**后续**：先测量上游引用变化与实际渲染次数，再选择优化位置。这些性能建议尚未实施。

### 2.2 Session 索引排序重复解析时间戳（未优化）

`buildSummariesFromIndex`（`:665-681`）无条件做 O(n) 对象分配 + 排序，比较器每次**重新解析 ISO 字符串**：

```ts
summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
```

比较器每次调用创建两个 `Date` 对象；总次数取决于排序算法和输入顺序。原报告按 n log n 估算的具体分配次数并非实测。

可评估预计算时间戳或缓存排序结果，后者需要明确失效条件。同样的比较器在 `:1104` 又写了一遍。

已有的保护包括：fast / incremental / full-validation 三条路径分明，stat 已并行化，`evictIfNeeded` 有 LRU 上限，`inFlight*` map 都在 `finally` 清理。这不构成对所有索引路径的无缺陷保证。C1 的投影去重已完成，排序优化仍未实施。

### 2.3 广播与入站排队（待测量）

- **activity 广播无按客户端过滤**（`subscriptions.ts:390-401`）：每个 `BusEvent` 原样转发给**每个**订阅者。N 个客户端 → 每个事件 N 次入队。
- **序列化是 per-client 的**（`ws-handlers.ts:175-178`）：`encode` 在**每个连接自己的队列**里执行，同一份 event 对象被 `JSON.stringify` N 次。10 客户端 × 8 KB × 100 event/s 的示例约为 8 MB/s 序列化输入量，属于假设负载，不是实测吞吐或耗时。
- **入站 promise 链无上限**（`ws.ts:190-205`）：出站背压做得很完整，入站完全不对称。

`ws-send-queue.ts` 已有保护：高水位停 drain、按 key 合并且原位替换、30s 停滞断连、4096 溢出断连、**每连接独立队列**（慢客户端不阻塞其他客户端）。广播优化应保留这些约束。

### 2.4 其他

- **飞书使用 WebSocket transport**（`lark-sdk-transport.ts`），并持久化事件身份用于去重。使用长连接本身不能排除共享 Node 事件循环上的阻塞风险；需测量具体处理函数。
- **Codex bridge 的 delta 热路径已有减负设计**（`:2114-2118`），journal 使用入队方式。评估实际磁盘写入频率仍需追踪 writer 的批处理和刷新策略。
- **飞书 fallback 逐消息查询的结论已排除**：`readCodexUsage` 本身每次调用启动 app-server，但 `FeishuCodexModelRouter.selectModel` 在 `fallbackUntilMs` 到期前直接返回，`readUsageSafely` 也复用并发中的 `usageRead`。重启后持久化 fallback 或等待期结束才触发相应复查；不能描述为 fallback 期间每条消息都查询。
- **Codex rollout 已实现有界读**：`codex-rollout-file.ts:304` 的流式迭代器带 byte 记账（CRLF、fatal UTF-8、双预算），其余 reader 的读取上限需逐一复核；其中 Kimi、Gemini 的 `getSession` 存在分别读取 summary 与 data 的路径（summary 一次 + data 一次），两次之间文件可能被 provider 改写 → summary 与 data 来自不同时刻。Codex 用 `revisionKey` 防住了这一点，Kimi/Gemini 没有等价检查。
- **活动上传状态缺少超时淘汰（待评估）**：`uploads` Map 中未完成的上传未见 TTL；长连接反复启动且不完成/取消可能积累状态。已有完成、取消、错误及断连清理，原文“唯一清理是连接关闭”不准确。`expiresAtMs` 属于任务附件保留及生成产物记录，且有消费者，并非活动 `UploadState` 中未使用的 TTL 字段。

---

## 3. 冗余与公共模块提取

仅合并已确认共享业务语义的重复；相似样板、不同协议和不同层的投影不自动构成维护缺陷。

### 3.1 提取候选与完成状态

| 候选 | 位置 | 状态与约束 |
| --- | --- | --- |
| `cachedToSummary` 复用 | `SessionIndexService.ts` | **已完成，见 C1** |
| 输入请求类型映射 | routes、runtime、`Supervisor` | 待确认各层映射语义一致，再抽公共函数 |
| `AsyncQueue` | `codex.ts`、`zcode-protocol/client.ts` | 待验证错误、关闭及取消语义，不以文本相似推断可直接替换 |
| 行解析与 stderr 尾部保留 | provider transport | 分别核对协议和缓冲上限；提取公共工具不自动解决无界保留 |
| API 客户端模块拆分 | `api/client.ts` | 可按已有功能域拆分，保持公共导出；属于维护工作 |
| 权限模式配置表 | `useProviderPermissionModeConfig.ts` | 可评估数据表驱动，同时保持两套语言包和 provider 行为 |
| 消息身份与工具名规范化 | pagination、display、session 解析 | 先区分空 UUID、别名和文件修改统计语义，统一行为需独立回归 |

C2 已消除流式确认规则的重复实现，不应再次把旧 `extractUserMessageText` / 裸 pending setter 路径列为待重构。其余候选不因本次三项修复自动完成，也没有承诺具体删行数或零风险。

### 3.2 不宜仅凭相似代码合并的边界

- `codex.ts` 使用常驻双向 app-server JSON-RPC，`codex-oss.ts` 使用每轮一次的 `codex exec`。协议生命周期不同，不能直接合并 transport。
- 多个 ACP provider 已复用 `acp/client.ts`。应先检查共享层是否覆盖目标行为，再新增抽象。
- `routes/sessions.ts → SessionCommandService → SessionInteractionService → InteractionBroker` 是调用分层；委派层数本身不是重复业务规则的证据。
- `normalization.ts` 与 `codex/normalization.ts` 分别处理入口分派和工具语义。合并前应确认是否真的重复相同契约。
- `c.json({ error }, status)` 之类错误响应样板可能具有不同业务语义，不宜按外观批量提取。
- watcher 与轮询并存可能是兼容或可靠性策略；判断冗余需查看触发频率和回退用途。

这些是保留边界的理由，不是对相关模块的全面无缺陷保证。

### 3.3 跨包 wire 契约维护（待逐项核对）

**以下属于契约维护候选，需逐个端点核对请求/响应及消费方。**

`packages/client/src/api/client.ts` 与服务端有独立维护的类型声明。初稿的“50 份 DTO / 12 份漂移”未附可复核清单，不再作为已确认缺陷数量。以下是需要核对的差异候选：

| 类型 | 待核对的声明差异 |
| --- | --- |
| `GlobalSessionItem` | 服务端有 `originChannel`，客户端 DTO 未声明 |
| `InboxItem` | server 多 `pendingRequestId`/`originChannel`；client 多 `runtime` |
| `VersionInfo` | server 多 `codexProtocol` |
| `ServerInfo` | server 多 `installId`/`capabilities` |
| `CodexStructuredUserInput` | 两侧字段集合不同，需核对使用的接口 |
| `CodexLoginStatus` / `CodexLoginMode` | 同名形状不同，先核对是否为同一接口 |
| `AuthStatus` | 双向存在不同字段，需确认投影关系 |

**`originChannel` 示例**：服务端和 shared 中存在该字段，客户端对应 DTO 未声明。TypeScript 类型声明不会删除运行时响应字段；这意味着缺少静态类型表达，是否造成产品功能缺失仍需检查消费需求，不能称为运行时静默丢弃。

客户端 DTO 可能是服务端类型的合理投影；同名类型也可能属于不同接口。只有确认属于同一 wire 契约后，才能将差异计为漂移或决定共享类型。

**修法方向**：可使用现有 `packages/shared` 边界承载公共 wire DTO。只迁移已确认属于同一 wire 契约的类型，并保留合理投影；收益和工作量尚未量化。

**一个反面提醒**：`ConnectionState`、`ContentBlock` 这类是**同名不同义**（client 的 `ConnectionState` 描述连接状态，server 侧有连接上下文），不是重复。统一时要注意区分，否则会制造新的混乱。

---

## 4. 剩余工作建议

1. **已完成，不再列为待办**：C1 投影去重、C2 流式确认与清理、C4 失败/中断结果。C6 和飞书 fallback 逐消息查询的结论已排除。
2. **先复现再修复**：C3 排空时序、C5 启动失败后的退出等待、external 初始快照的 `retryStatus` 差异、活动上传长期未完成的资源上限。
3. **性能先测量**：display 更新时的数组与 item 引用变化、索引排序解析、广播序列化及入站队列；不预先承诺提速比例。
4. **按契约分批重构**：确认 wire DTO 投影关系及空 UUID 语义后，再考虑公共类型、队列、行解析和输入类型映射。API 模块拆分属于独立维护工作。
5. **协议检查候选**：当前 `ci.yml` 未执行 `codex:protocol:check`。接入前需先核对 runner 是否安装匹配版本 CLI 及生成方式，不能假设增加一条命令即可运行。深导入 generated 类型是否绕过 barrel 也应按依赖目的评估。

## 5. 验证范围与限制

- 初始报告基于静态阅读；后续修复验证覆盖 C1、C2、C4 的 166 个相关用例，以及全仓类型检查、变更文件 Biome 和字体检查。不得据此声称整个代码库或全部 CI 已通过。
- 未运行浏览器或真实模型交互，未部署，也未重启/停止任何运行中的服务。
- 未做 profiler 或可比性能基准；“每帧成本”、渲染范围和容量估计均应以实际负载继续验证。
- C3、C5 等剩余事项的触发条件和影响范围尚待验证；类型重复或形状差异不自动等于功能缺陷。

## 6. CI 排查与后续验证（2026-10-15）

[CI 运行 38727590479](https://github.com/hustc5622/yepanywhere/actions/runs/38727590479) 对应 `1a91ad3a6`。lint 和类型检查通过，`pnpm test` 在 `ToolApprovalPanel.test.tsx` 的 IME 反馈提交用例失败：预期提交“请调整命令”，实际回调未调用。E2E 步骤因前序失败被跳过。

- `dd1a4eefa`：键盘测试在 `act` 中推进防误触定时器并刷新 React effect，再派发键盘事件，避免只等按钮 enabled 而监听闭包尚未更新的调度窗口。保留 IME 不提交、其他编辑器不触发审批的断言，并验证正常 Enter 只提交一次且不误批准。
- 项目扫描测试补充 `enableCursor: false`：本机全量测试发现 4 个用例读入真实 Cursor 会话目录。测试原本只隔离了其他 provider，新增 Cursor 后遗漏了该开关；这是独立于上述 CI 失败的测试隔离问题。
- 修复后本地 `pnpm test` 完整通过：shared 489、client 1454、server 4234，共 **6177 个通过，2 个已有跳过项**。`pnpm lint`、`pnpm typecheck` 通过；另运行 47 个相关用例核对审批、row key、项目扫描和飞书模型路由。

本节记录的是本地验证和原失败运行的证据；新提交的远端 CI 结果以 GitHub Actions 对应运行记录为准。本轮没有修改产品运行逻辑，也未启动本机浏览器验证。
