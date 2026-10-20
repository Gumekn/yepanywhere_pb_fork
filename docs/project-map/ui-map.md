# UI 与设计实现地图

[返回总览](README.md)。本页只确认路由、组件接线和样式定义；没有打开浏览器、看截图或验收真实视觉效果。源码里有 responsive、dialog 或主题样式，不能据此认定实际触控/无障碍/布局通过。

## 页面与路由

当前入口是 [packages/client/src/main.tsx](../../packages/client/src/main.tsx) 的 `Routes`，页面 lazy import。`BrowserRouter.basename` 取 Vite `BASE_URL`；前缀部署需同时考虑 server BASE_PATH。

| 路由 | 页面 / 页面模式 | 布局与关联能力 |
| --- | --- | --- |
| `/` | 重定向 `/projects` | 产品首页实际是项目入口 |
| `/login` | `LoginPage` | 不套 NavigationLayout；AuthProvider/authEvents 处理登录需求 |
| `/projects` | `ProjectsPage` | 项目卡片、目录选择，进入 session/new session |
| `/sessions` | `GlobalSessionsPage` | 跨项目会话列表、筛选及状态 |
| `/archive` | `ArchivePage` | 归档列表/恢复，对应 archive 与 metadata |
| `/search` | `SearchPage` | 跨会话全文搜索结果与定位 |
| `/reports` | `ReportsPage` | 报告文档、评论/上传等独立内容面 |
| `/agents`、`/inbox` | `AgentsPage`、`InboxPage` | agent 状态与分层收件箱；共享 activity/runtime 信号 |
| `/new-session` | `NewSessionPage` → `NewSessionForm` | provider/model/权限/附件/草稿，F1 |
| `/projects/:projectId/sessions/:sessionId` | `SessionPage` | transcript、composer、审批、inspector/文件详情/侧聊，F2–F4 |
| `/sessions/:sessionId` | `SessionLocatorPage` | 请求 locate 后跳到带 project ID 的会话 |
| `/terminal`、`/terminal/:terminalId` | `TerminalPage` | PTY 输出/输入/尺寸变化，不能当作普通文本消息 renderer |
| `/dsh` | `DshPage` | 侧栏入口。按需启动并内嵌本机 dsh Web，不是会话页 |
| `/settings`、`/settings/:category` | `SettingsLayout` | 分类菜单与对应内容组件 |
| `/projects/:projectId/file` | `FilePage` | 独立布局，无常驻 Sidebar |
| `/activity` | `ActivityPage` | 自有布局，活动流 |
| `/projects/:projectId` | 重定向 `/sessions` | 兼容旧项目入口 |
| `/git-status` | 重定向 `/settings/source-control` | 保留 query |
| `/devices`、`/devices/:deviceId` | `LegacyDeviceRedirect` | 只到 `/settings`，不再带 emulator query 或设备 ID |

除表中明确独立布局的页面外，主导航页面位于 `NavigationLayout`。其真实行为见 [packages/client/src/layouts/NavigationLayout.tsx](../../packages/client/src/layouts/NavigationLayout.tsx) `NavigationLayout/useNavigationLayout`：常驻桌面 sidebar、可折叠/拖宽；窄屏使用 overlay sidebar；`Outlet` 共享 context。断点由 `useSidebarWidth/useViewportWidth` 决定，不应另外猜一个统一设备宽度。

设置分类的事实来源：[packages/client/src/pages/settings/SettingsLayout.tsx](../../packages/client/src/pages/settings/SettingsLayout.tsx) `CATEGORY_COMPONENTS`：`feishu-authorization`、`appearance`、`library`、`notifications`、`webhooks`、`devices`、`local-access`、`providers`、`source-control`、`about`、`development`。菜单显示还看 [i18n-settings.ts](../../packages/client/src/i18n-settings.ts) `getSettingsCategories`；`development` 由 `getDevelopmentCategory` 追加，不能把有组件文件当成独立路由。`model`、`agent-context`、`emulator` 已不在表中，旧链接回到 `/settings`。这里的 `devices` 是浏览器档案和推送，不是已删除的设备串流页。

## 公共组件与复用入口

| 需要做什么 | 先找的实现 | 当前职责与影响范围 |
| --- | --- | --- |
| 新增全局状态/导航交互 | [App.tsx](../../packages/client/src/App.tsx) `App/AppContent`；[NavigationLayout.tsx](../../packages/client/src/layouts/NavigationLayout.tsx) | Toast/Auth/Inbox/SchemaValidation providers、连接提示、reload banner、onboarding；修改可能影响每页 |
| 新列表条目或状态展示 | [components/SessionListItem.tsx](../../packages/client/src/components/SessionListItem.tsx) `SessionListItem`；[StatusBadge.tsx](../../packages/client/src/components/StatusBadge.tsx) `SessionStatusBadge/NotificationBadge`；[PageHeader.tsx](../../packages/client/src/components/PageHeader.tsx) `PageHeader` | 先保持 runtime/ownership 与 unread 的语义，别只复用颜色 |
| 对话输入与附件 | [components/MessageInput.tsx](../../packages/client/src/components/MessageInput.tsx) `MessageInput`；[AttachmentComposer.tsx](../../packages/client/src/components/AttachmentComposer.tsx) `AttachmentComposer`；[hooks/useComposerDocument.ts](../../packages/client/src/hooks/useComposerDocument.ts) `useComposerDocument` | 输入、附件 token、工具栏与草稿生命周期；新建和继续会话都需要考虑 |
| 修改 transcript | [components/MessageList.tsx](../../packages/client/src/components/MessageList.tsx) `MessageList`；[RenderItemComponent.tsx](../../packages/client/src/components/RenderItemComponent.tsx) `RenderItemComponent` | 消息行/块渲染入口；先分清 projected display 与 legacy 数据来源 |
| 新增内容块类型 | [components/renderers/configuredRegistry.ts](../../packages/client/src/components/renderers/configuredRegistry.ts) `registry`；[ContentBlockRenderer.tsx](../../packages/client/src/components/renderers/ContentBlockRenderer.tsx) `ContentBlockRenderer` | text/thinking/tool use/tool result 的一级分发 |
| 新增工具展示或别名 | [components/renderers/tools/index.tsx](../../packages/client/src/components/renderers/tools/index.tsx) `ToolRendererRegistry`；[components/tools/metadata.ts](../../packages/client/src/components/tools/metadata.ts) `canonicalizeToolName` | 工具 registry 二级分发；MCP 有结构化 fallback，未知工具仍有通用 fallback。与 Codex 重合的 7 个别名在 [tool-name-aliases.ts](../../packages/shared/src/tool-name-aliases.ts) `SHARED_RENDERER_TOOL_ALIASES`；Pi 和 Codex `exec` 不进这张表 |
| 懒加载工具组与详情 | [components/blocks/DisplayToolGroupRow.tsx](../../packages/client/src/components/blocks/DisplayToolGroupRow.tsx) `DisplayToolGroupRow`；[ProjectedToolGroupRow.tsx](../../packages/client/src/components/blocks/ProjectedToolGroupRow.tsx) `ProjectedToolGroupRow`；[ui/DetailPanel.tsx](../../packages/client/src/components/ui/DetailPanel.tsx) `DetailPanel` | 独立 group/detail/output 请求；桌面 panel 与移动返回语义复用。详情不可从压缩 preview 反推全部内容。合集标题用 [ToolGroupDuration.tsx](../../packages/client/src/components/blocks/ToolGroupDuration.tsx) `ToolGroupDuration` 显示 `durationMs`/`timedCount`，单步用 [ToolDuration.tsx](../../packages/client/src/components/blocks/ToolDuration.tsx) `ToolDuration` |
| 通用弹窗 | [components/ui/Modal.tsx](../../packages/client/src/components/ui/Modal.tsx) `Modal` | portal、dialog、history/back 处理；不能凭此认定焦点与嵌套交互已通过验收 |
| 设置行、开关、通知测试 | [components/ui/SettingsItem.tsx](../../packages/client/src/components/ui/SettingsItem.tsx) `SettingsItem`、`SettingsToggle`、`NotificationTestActions` | 浏览器通知、Web Push、原生推送共用这一层外壳。权限、订阅和各通道自己的说明仍留在三个 Toggle 里 |
| 嵌套 transcript / subagent | [components/TranscriptRendererProvider.tsx](../../packages/client/src/components/TranscriptRendererProvider.tsx) `TranscriptRendererProvider`；[SubagentDetailProvider.tsx](../../packages/client/src/components/SubagentDetailProvider.tsx) `SubagentDetailProvider` | 上下文注入嵌套 renderer、按需取子 agent 内容；新增 renderer 需检查嵌套场景 |
| 审批与问答 | [components/ToolApprovalPanel.tsx](../../packages/client/src/components/ToolApprovalPanel.tsx) `ToolApprovalPanel`；[QuestionAnswerPanel.tsx](../../packages/client/src/components/QuestionAnswerPanel.tsx) `QuestionAnswerPanel` | 可用按钮由 provider/request 决定；提交由 SessionPage → API，不能只改面板文案绕过 F3 |
| 错误/等待提示 | [components/ErrorBoundary.tsx](../../packages/client/src/components/ErrorBoundary.tsx)、[Skeleton.tsx](../../packages/client/src/components/Skeleton.tsx)、[contexts/ToastContext.tsx](../../packages/client/src/contexts/ToastContext.tsx) | 渲染错误、页面骨架、操作反馈分层；请求失败与“没有数据”应分别查看现有用法 |
| Provider 能力 UI | [providers/registry.ts](../../packages/client/src/providers/registry.ts) `getProvider`；[providers/types.ts](../../packages/client/src/providers/types.ts) `Provider` | 未知 ID 返回最小能力 GenericProvider；supportsCloning 与支持历史 edit-fork 不是一个能力 |

## Token、主题、字体与文案

- [packages/client/src/styles/typography.css](../../packages/client/src/styles/typography.css) `:root` 是字体/字号 token 的唯一入口；`--font-sans/--font-mono/--font-size-*`，移动输入有 `--font-size-input`。用户缩放见 [hooks/useFontSize.ts](../../packages/client/src/hooks/useFontSize.ts) `initializeFontSize/useFontSize`，不能在新组件重新定义比例。
- [packages/client/src/styles/index.css](../../packages/client/src/styles/index.css) `:root` 和 `[data-theme]` 提供色彩、space/radius、内容宽度、sidebar/inspector 等变量，并导入 typography/renderers/tool-rows/emulator。不是一个每个属性都已 token 化的设计系统。
- [hooks/useTheme.ts](../../packages/client/src/hooks/useTheme.ts) `THEMES/initializeTheme/useTheme` 支持 auto/light/dark/verydark，将偏好写 localStorage 和 `data-theme`；mobile shell 有 postMessage 同步。`main.tsx` 在 React 首次渲染前初始化主题/字号/tab size。
- [i18n.tsx](../../packages/client/src/i18n.tsx) `SUPPORTED_LOCALES/I18nProvider` 只支持 `en`、`zh-CN`，中文懒加载；新 UI 文案应同步 [en.json](../../packages/client/src/i18n/en.json) 和 [zh-CN.json](../../packages/client/src/i18n/zh-CN.json)。本轮未逐 key 审计翻译。
- 相关约束与将来检查入口：[docs/project/typography.md](../project/typography.md)、[scripts/check-typography.mjs](../../scripts/check-typography.mjs)；`pnpm lint:typography` 本轮未执行，因为没有修改 UI 源码。

## 已确认的差异与未验收部分

| 差异 | 源码事实 | 不应据此推导 |
| --- | --- | --- |
| 两条 transcript 模型 | `history=legacy` 选择旧路径；默认使用 display snapshot/patch，inspector 还可按需取旧详情 | 不是自动发现了重复可删模块；迁移、诊断和兼容可能需要保留 |
| Git 内容仍从旧页面文件复用 | `SourceControlSettings` 导入 `GitStatusContent`；`/git-status` 重定向到源码设置 | 文件名是 Page 不代表有同名直达路由。`EmulatorPage` 与 `EmulatorSettings` 已删除，不能再当作复用入口 |
| 终端单独字体入口 | 存在 `terminal-font.css`，并且项目字体规则允许终端例外 | 不能按普通正文规则直接改终端字形尺寸；需检查测量与 fit |
| 模态/详情布局不同 | Modal portal 到 body，DetailPanel 可挂到 layout root 并处理嵌套关系 | 代码有 z-index/portal 不证明遮挡、焦点顺序、返回键正确 |
| 桌面壳、mobile shim、站点是独立界面 | 各有自己的入口/样式，见 README 应用表 | 不应把主客户端 token 自动视为覆盖这些应用 |

**待真实页面验收**：窄屏/旋转/软键盘、长会话滚动与选区、中文换行、四种主题与用户字号、嵌套 panel 焦点与返回键、屏幕阅读器标签、WebView shell 与主页面同步。这里只列核查目标，不认定有视觉缺陷。

现有测试入口包括 [components/ui/__tests__/DetailPanel.test.tsx](../../packages/client/src/components/ui/__tests__/DetailPanel.test.tsx)、[components/__tests__/composerFlows.test.tsx](../../packages/client/src/components/__tests__/composerFlows.test.tsx)、工具 renderer 的 `__tests__` 以及 F2 的 hook 测试。除 F2 中明确说明的测试外，本页只盘点测试位置，没有逐一审阅断言或执行。
