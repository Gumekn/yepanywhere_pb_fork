# Codex 归档与旧记录修复

Yep 与 Codex CLI／桌面端共用源记录。Yep 中的归档只表示从 Yep 默认列表隐藏，不应改变 Codex 中的历史或归档状态。

## 行为

- Codex 与 `codex-oss` 的手动、自动归档只写 `session-metadata.json` 中的 `isArchived`，取消归档只清除这个状态。
- 自动归档仍在北京时间 04:00 检查超过 7 天的会话，跳过已归档、Yep 置顶、运行中或被检测为外部活跃的会话。缺少元数据服务时跳过 Codex，绝不回退到移动文件。
- 手动归档保留原有运行态限制，但不会为归档终止 Codex 空闲进程。
- 不移动、覆盖、删除、压缩 Codex 源文件，不调用 Codex 原生归档接口，不伪造文件删除／创建事件。物理归档服务本身拒绝新的 Codex 归档。
- Claude、Pi、Cursor 的物理归档行为保持原样。

## 已恢复的旧物理归档

旧实现把源记录移到 `archive/sessions/codex/`，而 Codex 仍依赖原路径，可能报 `missing source rollout`。先恢复源文件，再处理 Yep 的残留状态。不要直接删除归档目录或整个 manifest。

确认所有待处理 Codex 文件已恢复后，执行：

```sh
pnpm exec tsx scripts/reconcile-restored-codex-archives.ts /absolute/path/to/yep-data
```

工具逐份流式校验源文件中的完整历史前缀与归档副本的 SHA-256，允许恢复后继续追加消息；任何缺失或冲突都会拒绝修改状态。若用户已在 Codex 原生界面归档，可在核对 Codex 实际登记路径后，传入第二个 JSON 文件参数，以「旧绝对路径 → 已核实的当前绝对路径」提供映射。工具将映射记录到迁移意图中，校验当前位置的文件，不搬回原路径，也不改 Codex 原生归档状态。通过后：

1. 在 `archive/backups/codex-restored-*/` 备份原始 manifest、元数据和迁移记录。
2. 移除 manifest 中对应 Codex 记录，并将其 Yep `isArchived` 设为 `false`。保留其他会话、标题、置顶、别名等字段。
3. 保留源文件与归档副本，均不写入；仅原子替换 Yep 状态文件。
4. 写入 `archive/codex-restored-migration.pending.json`，供新版下次正常启动时、加载内存状态之前重放。重放允许源文件在原有历史后追加消息，但不接受冲突历史；冲突会保留待迁移记录并中止启动，需核对文件后重试。
5. 重放完成后删除 pending 文件。以后用户主动设置的逻辑归档不再被迁移清除。

**运行中的旧服务不会热加载这些状态，也不会自动获得代码修复。** 它可能暂时仍显示旧归档状态，或把旧内存状态写回磁盘；pending 文件不在旧服务的写入范围内，会在新版启动时再次校正。工具本身不部署、不停止或重启服务；在正式启用新版前，旧版仍可能移动其他超过 7 天的 Codex 会话。

旧 manifest 仍有记录时，取消归档只允许清理已恢复且与归档历史相符的 Codex 条目（源文件可追加）。源文件缺失或内容冲突时返回 `restore_conflict`，要求先核对恢复，不会覆盖文件。归档副本与清单备份始终保留。

## 验证

```sh
pnpm --filter @yep-anywhere/server test -- test/archive test/routes/sessions-metadata.test.ts test/sessions/codex-compressed-rollout.test.ts
pnpm --filter @yep-anywhere/server exec tsc --noEmit
```

覆盖自动归档、手动归档／取消归档、`codex-oss`、压缩源文件、空闲进程保留、缺失／冲突源文件拒绝迁移、旧进程写回后的重放和迁移幂等性。测试只使用临时目录，不启动真实 provider 或浏览器。

## 2026-11-12 修复记录

- 已核实旧自动归档移动源记录与 Codex 的 `missing source rollout` 报错对应。
- 本机 24 条已恢复会话的旧物理归档记录及 Yep 隐藏标记已清理；原清单、元数据和迁移意图均已备份，归档副本保留。聊天内容、会话 ID 和本机绝对路径不进入仓库。
- 24 份源记录的完整历史前缀校验通过。其中 1 份恢复后新增了消息，2 份随后由 Codex 原生归档，均保留当前内容和原生状态。
- 24 个聊天通过 Codex 最近一轮历史读取接口验证；本轮未逐个检查桌面界面、附件或重新遍历全部分页。
- 62 项聚焦测试、服务端 TypeScript 类型检查、变更文件 Biome 检查及 `git diff --check` 通过。
- 本次仅修改代码及本机 Yep 状态，未部署、未重启服务。pending 迁移将在新版下次正常启动时重放；运行中的旧服务仍执行旧逻辑。

### 历史列表规则保持不变

- 侧栏最近会话显示未归档且最近 24 小时更新的会话，以及 Yep 置顶会话；较早分组显示已加载的较早、未置顶、未归档会话。
- 侧栏基础加载最近 50 条，并补充置顶及近期项目覆盖，不代表完整历史全集。
- 「全部会话」普通入口默认筛选最近 7 天并排除归档；置顶不受时间窗口限制，可清除时间筛选并继续分页加载。
- 选择「已归档」才包含 Yep 归档会话，仍受时间、项目、provider 等筛选条件影响。找较老的归档会话需同时清除时间限制。
- Yep 归档与 Codex 原生归档仍独立；此次未扩大原生归档目录的发现范围。清除旧 Yep 标记不保证对应会话立即出现在默认列表。
