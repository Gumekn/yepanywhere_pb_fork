# Codex：仅模型推理使用远端代理

## 原因与分流边界

原先的本机 `yep-codex-proxy` 包装脚本从 `~/.codex_proxy_env` 读取通用 `HTTP_PROXY/HTTPS_PROXY`，然后启动整个 Codex。HTTP MCP 与模型请求处于同一个进程，命令工具还会继承进程环境，因此代理设置扩散到了工具流量。飞书 MCP 配置虽然启用，初始化仍因内网地址被送往远端代理而超时。只给 `NO_PROXY` 添加已知 MCP 域名，会让未来增加的工具继续遇到这个问题。

新的入口是 `scripts/codex-model-proxy.zsh`，实现放在 `packages/server/resources/codex-model-proxy/`，构建时复制到 bundle 的 `resources/codex-model-proxy/`。它按照请求用途分流：

| 请求 | 网络路径 |
| --- | --- |
| OpenAI Responses 的 POST 和 WebSocket | Codex → 本机模型转发入口 → 原远端代理 → OpenAI |
| Responses 压缩、memory trace summary | 同模型推理 |
| 模型目录、独立搜索等同源非推理接口 | 本机模型转发入口 → 直连 OpenAI |
| HTTP MCP、命令行工具、工具访问的新域名 | 直接使用本机网络，不继承远端代理 |
| 登录、token 刷新、账号查询、其他 provider | 沿用原地址，通过本机网络连接 |

转发入口只监听 `127.0.0.1` 的临时端口，不是通用 HTTP/CONNECT 代理。只有精确匹配 `/responses`、`/responses/compact`、`/memories/trace_summarize` 的 POST，以及 `/responses` 的 WebSocket upgrade 才使用远端代理；不解析或记录请求体、令牌、响应内容。模型代理失败或返回重定向时显式失败，不回退为直连推理。

## Codex 接入方式

本机 CLI `0.161.0` 已通过只读协议探测确认支持 `openai_base_url` 和 `respect_system_proxy`。实现保留内置 `openai` provider，使用官方提供的模型地址覆盖能力，不改 `auth.json`、MCP URL 或用户配置文件。

每次启动时，包装器先启动一个短暂的只读 app-server，使用原来的配置参数执行 `config/read` 和 `account/read(refreshToken: false)`，获取有效配置和账号类型，不发送模型 turn。ChatGPT 账号保留 `/backend-api/codex` 前缀，API key 账号使用 `/v1`；已有自定义网关不接管。随后为真实 app-server 注入临时 `openai_base_url`。HTTP 流、zstd 请求、认证头和 WebSocket 帧保持透传，支持原有 CA bundle。

启动真实 Codex 前移除通用代理变量及模型代理专用变量，设置 `NO_PROXY=no_proxy=*`，并禁用 Codex 的系统代理发现。远端代理凭据仅由包装器的模型转发模块持有。工具自身明确配置的代理、shell 初始化脚本主动重新设置的代理不在环境继承清理范围内。

该启动入口适用于本机标准 OpenAI/ChatGPT endpoint；不自动接管企业 workspace 自定义的后端路由、第三方网关或实时语音的独立通道。若实际启用这些功能，需要先核对对应 CLI 的路由契约。

## 配置与本机启用

私有代理文件仍可使用 `~/.codex_proxy_env`，由 zsh 读取；其中原来的 `HTTPS_PROXY` 只用于获取模型模块的上游地址，之后会从 Codex 环境清除。也可直接设置专用 `YEP_CODEX_MODEL_PROXY_URL`。不要把含凭据的代理地址提交到仓库。

| 变量 | 用途 |
| --- | --- |
| `YEP_CODEX_PROXY_ENV_FILE` | 私有环境文件，默认 `~/.codex_proxy_env` |
| `YEP_CODEX_MODEL_PROXY_URL` | 模型专用上游 HTTP/HTTPS CONNECT 代理 |
| `YEP_CODEX_REAL_PATH` | 真实 Codex 可执行文件，不能指向旧的全局代理包装器 |
| `YEP_CODEX_PROXY_NODE` | Node 路径，默认 `node` |
| `YEP_CODEX_MODEL_PROXY_ENTRYPOINT` | `launcher.mjs` 路径，默认仓库内资源路径；部署后可指向 bundle 资源 |

已有 `YEP_CODEX_PATH` 指向固定包装脚本时，可先备份脚本，再将其改成导出真实 CLI/Node 路径并 `exec /bin/zsh <仓库路径>/scripts/codex-model-proxy.zsh "$@"`。这样新启动的 Codex 进程会使用新逻辑，不必重启 Yep 服务；已有进程保持原环境。安装入口切换应在聚焦测试和真实 CLI 的只读 MCP 检查通过后进行。

不要通过重启 runtime、bridge 或接管旧 session 强行刷新工具。原 session 要恢复 MCP，需要明确授权后让它在新的 Codex 进程中重新加载；仅修改包装脚本不会更改已有工具列表。

## 协议 stdio 约束

启动器的 fd 0/1 由真实 app-server 继承，是 Codex JSON-RPC 通道。Node 会在首次访问 `process.stdout`/`process.stdin` 时打开句柄，并把共享的打开文件描述设为 `O_NONBLOCK`；`Readable#pipe` 判断 `dest !== process.stdout` 时就会触发这一步，`http-proxy` 处理第一条请求就会经过这里。Codex 的 stdout 写线程按阻塞写设计，遇到 `EAGAIN` 会直接退出，此后通知和 `turn/completed` 全部丢失，Yep 会把会话一直显示为运行中。因此入口启动时调用 `isolateProtocolStdio()`，把这两个属性替换为不持有 fd 的空流。启动器不要向 stdout 输出内容，诊断信息只写 stderr。

## 验证

```sh
pnpm --filter @yep-anywhere/server test -- test/codex/model-proxy.test.js
```

测试使用真实本机 HTTPS 服务、CONNECT 代理和 WebSocket，验证模型与同源工具请求分流、SSE/二进制请求透传、代理认证隔离、取消传播、错误及重定向不回退，以及工具子进程的直连环境。使用本机 Codex 验证时仅创建临时 thread、等待 MCP ready 并调用只读工具，不发起付费模型请求。真实 OpenAI 推理端到端验收与这些检查应分开汇报。
