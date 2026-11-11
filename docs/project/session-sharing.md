# 会话只读分享与 transcript 导出

## 能力

| 入口 | 鉴权 | 内容 |
| ---- | ---- | ---- |
| 会话菜单「分享链接…」→ `/share/<token>` | 无需登录，token 即凭证 | 生成时冻结的只读快照，按正常会话界面渲染 |
| `GET /api/public/session-shares/<token>` | 无需登录 | 快照 JSON（`PublicSessionShareResponse`） |
| `GET /api/public/session-shares/<token>/transcript.md` | 无需登录 | 同一快照的 Markdown |
| `GET /api/projects/:projectId/sessions/:sessionId/transcript` | 正常 API 鉴权 | 实时会话的 Markdown／JSON 导出 |
| `POST/GET/DELETE /api/session-shares` | 正常 API 鉴权 | 创建、列出、撤销分享链接 |

transcript 查询参数（两个 Markdown 接口通用）：`thinking=1` 包含思考，`toolOutputLimit=<N>` 调整每个工具结果的截断长度（`0` 不截断，默认 4000）；实时导出还支持 `format=json`。

## 实现要点

- 抓取：`session-shares/session-payload-loader.ts` 在进程内调用 `app.fetch` 重放 `GET /api/projects/:p/sessions/:s`，并带上 `WS_INTERNAL_AUTHENTICATED` 标记。所以快照与所有者看到的内容一致（包括服务端渲染的 Markdown `_html`），适用于所有 provider。遇到 `pagination.hasOlderMessages` 时按 `beforeMessageId` 往前翻页并按消息 id 去重；超过 40 MB 时改用 `deferMedia=1` 重试。
- 存储：`{dataDir}/session-shares/index.json` 保存所有者记录，`snapshots/<token>.json` 保存快照正文，目录权限 0700、文件 0600。每次读写都重新读取 index，过期记录在访问和列出时清理。
- 快照只保留标题、provider、模型、项目目录名和时间，不包含 `projectId`、项目完整路径和会话 ID。消息正文本身仍可能提到路径，分享前需要所有者自己判断。
- 鉴权豁免：`middleware/auth.ts` 对 `PUBLIC_API_PREFIX`（`/api/public/`）放行；匹配前会先去掉 `basePath`。新增公开接口必须放在这个前缀下，并且自行校验凭证。
- 客户端：`main.tsx` 匹配到 `/share/<token>` 时不挂载 `<App>`（登录门禁、活动流、引导都假定当前是所有者会话），直接渲染 `SharePage`。页面用不带凭证的 `fetch` 请求公开接口，并复用 `MessageList` 渲染消息。

## 安全提示

分享链接只能保护它指向的那一份快照。如果服务本身没有开启登录（`/api/auth/status` 返回 `enabled:false`）且暴露在公网，任何人都可以直接调用全部 API。对外分享前请先开启密码登录。
