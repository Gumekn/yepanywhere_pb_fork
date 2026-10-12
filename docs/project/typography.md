# 客户端字体与字号约束

## 唯一入口

产品 Web 客户端及复用该客户端的移动壳，共用
`packages/client/src/styles/typography.css`。它集中定义字体栈、字号阶梯、正文行高、
页面默认标题和表单继承规则。营销站、终端画面和用户文档原有内容不按普通 UI 强行同号。

这次漂移的直接原因是：主会话列显式指定了 `--font-size-base`，旁路面板作为它的兄弟节点，
继承到没有设置基础字号的 `body`，使用浏览器默认的 16px。即使字体家族相同，
旁路的按钮、提示和输入框仍比使用 13px 基准的主列大。现在 `body` 明确使用基础字号，
新页面、右侧栏和挂在 body 下的弹窗无需各自补一遍默认字体。

## 使用规则

普通 UI 沿用系统无衬线字体 `--font-sans`，代码和路径使用 `--font-mono`。
不引入页面专属字体栈，不增加网络字体请求。不同操作系统会选择本机相应字体，
不承诺跨系统逐像素一致；同一设备上的产品界面应使用相同角色。

| 用途 | 变量 | 默认比例下的尺寸 |
| --- | --- | --- |
| 时间、计数等元信息 | `--font-size-xs` | 10px |
| 辅助说明、紧凑标签 | `--font-size-sm` | 12px |
| 正文、表单、操作按钮 | `--font-size-base` | 13px |
| 面板标题、强调标签 | `--font-size-lg` | 14px |
| 较大的区块标题 | `--font-size-xl` | 16px |
| 二级区块标题 | `--font-size-2xl` | 18px |
| 页面内章节标题 | `--font-size-3xl` | 20px |
| 页面标题 | `--font-size-title` | 24px |
| 少量大标题 / 大数值 | `--font-size-display` / `--font-size-metric` | 32px / 40px |
| 完整报告的阅读正文 | `--font-size-reading` | 15px |

这些数值保留了项目现有的紧凑界面密度，实际渲染同时受用户字号偏好和浏览器缩放影响。
已有默认偏好仍为「大」，并未重置用户设置。不要为了“统一”把正文、辅助标签、标题和代码
全部设成同一个尺寸。

特殊角色也必须使用已有变量：

- `--font-size-input`：移动输入框最低 16px，避免聚焦时自动放大，与主输入框一致。
- `--font-size-inline-code`：相对当前正文的内联代码比例。
- `--font-size-inline-caption`：跟随所在行缩放的补充信息。
- `--font-size-glyph`：复选标记等装饰性字形，不用于可阅读正文。

新增组件默认继承正文即可。确实需要区分角色时，例如：

```css
.example-panel {
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
}

.example-panel-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.example-panel-hint {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.example-panel-path {
  font-family: var(--font-mono);
}
```

React 内联样式同样使用这些变量：`fontSize: "var(--font-size-sm)"`。
表单控件全局 `font: inherit`，组件若另设字号，应明确使用角色变量。
不要在页面里重定义 `--font-size-*`，不要用 `calc(token * 系数)` 隐藏另一套字号，
也不要给普通页面添加 fallback 来掩盖拼错的变量名。

## 字号设置只缩放一次

`useFontSize` 只修改根元素的百分比字号。普通字号变量使用 `rem`，因此正文、标题、
控件和侧栏同时缩放；内联代码比例有意随所在正文变化。旧版给四个 token 单独写 px
覆盖的做法已移除，并会清理遗留内联覆盖。

字体设置不应改变终端网格或 SVG 图标内的坐标系：xterm 的固定字格字号与 Nerd Font
仍由终端适配层控制；SVG 中小型 A 徽标的 `fontSize="8"` 属于图标几何尺寸。

## 自动检查

```bash
pnpm lint:typography
pnpm test:typography
```

`scripts/check-typography.mjs` 使用 PostCSS 和 TypeScript AST 扫描客户端源码，检查：

- CSS、React 内联样式、JSX 字体属性与 DOM 字体写入中出现的硬编码字号 / 字体栈；
- 未定义的字体变量，例如已修复的 `--font-size-md`；
- 在组件里重定义全局字号变量；
- 绕过规则的 `font` 简写、局部倍数或动态字号表达式；
- 生成 HTML 中的静态字体声明。

检查接入根 `pnpm lint`、客户端两个正式构建入口及 CI。未来新增的 `.css`、`.ts`、
`.tsx` 文件自动纳入扫描，没有“旧违规数量基线”，不能通过换文件名绕开。

仅保留源码中有明确原因的窄例外：终端 API 的特定参数、终端 `@font-face` 名称、
SVG 徽标坐标、CSS 加载前的启动画面，以及 CSS 故障时错误页的已知 token fallback。
新增例外需同时修改规则说明和反例测试，不能整文件豁免。

静态检查不能替代视觉判断：字号角色是否选对、中文换行、滚动与移动键盘空间仍需要按
改动范围验证；浏览器自动化继续遵守仓库的用户授权要求。
