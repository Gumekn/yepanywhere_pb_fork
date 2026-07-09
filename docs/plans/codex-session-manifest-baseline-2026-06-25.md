# Codex Session Manifest Performance Baseline

Date: 2026-06-25 11:22 CST

Scope: pre-manifest baseline, after the first optimization pass that split global stats from `/api/sessions` and reused reader-provided `mtime/size` in session indexes.

## Local Session Tree Size

- Codex JSONL files: 555
- Claude JSONL files: 1439

## Running Service Log Snapshot

历史来源：旧 nohup 生产运行器的本地日志快照。当前生产模式由 LaunchAgent 守护，日志位于 `~/.yep-anywhere/logs/server-launchd.*.log`。

- `SessionIndexService mode=full dir=/Users/yueyuan/.codex/sessions`
- Count: 233
- Average duration: 63140.7 ms
- Min duration: 259 ms
- Max duration: 193969 ms
- Total stat calls: 6374
- Total parse calls: 29

Note: this log spans multiple code states and runtime conditions, so it is useful as evidence of Codex full-validation long tails, not as a clean A/B baseline.

## Source-Level Isolated Benchmark

Command shape: one-off `tsx` script using a temporary index directory, no service restart, no writes to production indexes.

Data:

- Sessions dir: `/Users/yueyuan/.codex/sessions`
- Codex projects discovered: 21
- Codex sessions listed across projects: 553

Results:

| Operation | Duration | Requests | Full scans | Stat calls | Parse calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| `CodexSessionScanner.listProjects()` | 457 ms | n/a | n/a | n/a | n/a |
| cold index, all Codex project scopes | 8302 ms | 21 | 21 | 0 | 555 |
| warm index, all Codex project scopes | 9 ms | 42 cumulative | 42 cumulative | 0 | 555 cumulative |

Interpretation:

- The previous `mtime/size` reuse removed repeated stat calls from the Codex full-validation path.
- Cold all-project listing is still expensive because each Codex project scope validates independently over the shared physical sessions tree and parses cache misses in its own project-scoped index.
- A physical-tree manifest should reduce repeated project filtering/enumeration work and is a prerequisite for moving toward one physical Codex summary index shared across project scopes.

## Post-Manifest Source-Level Benchmark

Date: 2026-06-25 11:29 CST

Scope: current source after introducing a shared Codex physical-tree manifest used by both `CodexSessionScanner` and `CodexSessionReader`. No running service restart.

Data:

- Sessions dir: `/Users/yueyuan/.codex/sessions`
- Codex projects discovered: 21
- Codex sessions listed across projects: 554

Results:

| Operation | Duration | Requests | Full scans | Stat calls | Parse calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| `CodexSessionScanner.listProjects()` | 338 ms | n/a | n/a | n/a | n/a |
| cold index, all Codex project scopes | 6511 ms | 21 | 21 | 0 | 556 |
| warm index, all Codex project scopes | 1 ms | 42 cumulative | 42 cumulative | 0 | 556 cumulative |

Post-manifest interpretation:

- Project discovery and project-scoped Codex file enumeration now share one short-lived physical-tree manifest keyed by sessions root.
- The source-level cold all-project path improved from 8302 ms to 6511 ms on this machine, with one additional Codex session present during the post run.
- The remaining cold cost is summary parsing across project-scoped indexes. The next larger optimization is a physical Codex summary index shared across project scopes, so one session file is parsed once per physical root instead of once per logical project scope.
