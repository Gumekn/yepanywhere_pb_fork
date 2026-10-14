# Cursor 接入

Cursor 使用本机 `agent acp`，账号来自 Cursor CLI 的现有登录。新建页显示账号、套餐、账期、套餐内用量、Cursor 模型/第三方模型用量，以及已启用的按量消费。刷新会重新检查登录和运行时状态；登录失效时显示 `agent login` 指引。

## 数据来源

- 身份：`agent status --format json`。当 CLI 拉取远端用户详情超时，使用与当前未过期 access token 的 `sub` 严格匹配的 `cli-config.json.authInfo` 恢复身份；无法确认时显示查询失败，不误报未登录。CLI 明确返回未登录时不使用此回退。
- 额度：`https://cursor.com/api/usage-summary`，这是 Cursor 控制台使用的内部接口，并非稳定的公开 API。只展示接口实际返回的指标；缺失数据不补零，也不根据套餐价格推算。
- macOS 凭据：只读 Keychain 中 `cursor-access-token` / `cursor-user`，不读取或轮换 refresh token，也不复制凭据到项目、响应或日志。Cookie 的用户标识来自 access token 的 JWT `sub`，不能使用 CLI 返回的数字 `userId`。
- 默认缓存 60 秒并合并并发查询。刷新失败时，仅为同一账号保留上次成功的用量并标明时间和过期状态；退出或换号会丢弃旧账号的数据。API key 登录无法提供控制台凭据时显示控制台入口。
- 前端账号请求遇到网络、服务端或登录状态查询的临时故障时，最多自动重试 3 次；重连、恢复页面或网络后重新查询，手动重试入口在用量区折叠时也可见。首次查询失败沿用 provider 列表里的账号身份，收到明确退出登录的结果后立即清除。

## 会话与部署

- 权限模式为“修改前先询问”“计划模式”“本会话自动允许”。后者由 Yep 对 Cursor 发来的工具请求逐次返回 `allow_once`，不写入全局规则，可随时切回询问；原生拒绝规则不会变成可批准请求，提问和计划确认仍交给用户。CLI 的 `--force / --yolo` 是 ACP 无法动态切换的启动参数，本接入不以该参数实现会话模式。
- 工具审批保留 ACP `options`；仅在 Cursor 提供 `allow_always` 时显示“始终允许”，用户选择后原样返回对应的 `optionId`，由 Cursor 保存命令、路径或工具的允许规则。普通“是”始终只返回 `allow_once`，不会扩大为永久批准；命令请求仅携带标题时也展示实际命令。

- 模型目录通过只读 ACP 扩展 `cursor/list_available_models` 获取，保留原生 `configOptions` 的参数名、默认值和支持选项，不再把思考强度、Fast 等组合展开成数百个模型。目录读取不创建会话或调用交互登录，15 秒超时并合并并发读取；旧 CLI 不支持该扩展时回退到 `--list-models`。
- 新建页沿用 Codex 的模型下拉和 Fast 开关样式，思考开关、强度、上下文仅在模型声明支持时出现。Cursor Fast 使用它自己的 `fast` 参数，不借用 Codex 的 `serviceTier`。完整选择以 CLI 原生表达式保存，例如 `gpt-5.6-sol[context=1m,reasoning=xhigh,fast=true]`，创建会话时原样传给 `--model`。“设为默认”保存在 `newSessionDefaults.byProvider.cursor`，与权限一起恢复；旧版组合 ID 保留到用户主动重新选择模型。

- 等待 ACP 完成初始化并返回真实会话 ID，最长 30 秒，避免把临时 ID 交给上传/发送流程。
- 回复、取消和失败都结束本轮；逐步转发正文，并复用已有提问、工具审批和计划审批面板。单次批准不会升级为永久授权。
- 历史读取 `~/.cursor/acp-sessions/<id>/store.db`，保留工具调用、参数、结果和失败状态；缓存修订包含 SQLite WAL 与元数据。Cursor 有些模型仅在历史里保存加密思考签名，不能从签名恢复思考正文。
- 上下文用量从最新根节点 `ConversationStateStructure.token_details` 读取 `used_tokens`、`max_tokens` 和 `breakdown`，输入框显示用量，点击查看原生分类估算。现有展示流读取到新快照后推送用量，重连时重放最近值，不增加独立轮询或模型请求。只跟随最新根，压缩后允许数值下降，不累加历史根或子智能体。协议已对照本机 CLI `2026.10.01-e373342` 的 `index.js` 与只读数据库核实；缺失/不兼容时不虚构用量或窗口，不把 Desktop 的窗口配置直接套给 CLI。持久化分类快照必须与当前总量和窗口一致，否则只显示总量。
- 展开实时思考时按 ACP 消息 ID 读取有大小上限的正文缓存；Web 重启或缓存失效后，从保留期内的 runtime 日志恢复。原生数据库的哈希 ID 不用于查找实时消息。若日志也已淘汰，不推测或还原加密思考。
- Cursor 会将部分后端错误输出为独立正文（例如 `Error: RetriableError: [resource_exhausted] Error`），再返回 `end_turn`。Yep 将这类已知错误记为失败，并从旧 runtime 日志恢复错误提示；不会因此自动续发可能带有写操作的任务。
- 手动归档移动完整会话目录，包含 `store.db`、WAL/SHM、`meta.json` 及附件；恢复同样按目录进行，原位置存在时拒绝覆盖。执行中的会话仍遵守通用归档限制。
- ACP 流式 UUID 与原生历史 ID 不同，通过原生会话内的回合序号限定对齐范围，避免把上一轮相同回答误认为本轮已经落盘。
- 外置 runtime 在状态接口公布已启用 provider 和 Cursor 接入版本。仅包含 provider 名称不能证明已加载最新修复；版本过旧时提示更新，API 返回带错误码的 503。需要在允许中断活跃会话的窗口更新 runtime，不能只更新 Web。
- IDE 聊天、Cloud Agents、会话分支和多账号切换不在当前接入范围内。

## 参考

- [Cursor 官方 ACP 文档](https://cursor.com/docs/cli/acp)：认证、会话、权限与扩展请求。
- [Brink 的 Cursor 实现](https://github.com/semihtalii/brink/blob/main/Sources/Brink/CursorProvider.swift)：CLI Keychain 凭据及控制台用量接口。Cookie 身份以本机实测结果修正。
- [CodexBar 的 Cursor 文档](https://github.com/steipete/CodexBar/blob/main/docs/cursor.md)：用量字段、账期与未知数据的处理。
- [Codeg 的 Cursor parser](https://github.com/xintaofei/codeg/blob/main/src-tauri/src/parsers/cursor.rs)：原生 store 与 WAL 的读取参考；本项目的工具结构使用本机真实 ACP 会话核对。
