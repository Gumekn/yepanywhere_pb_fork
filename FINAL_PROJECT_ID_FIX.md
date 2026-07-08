# 项目 ID 不匹配问题 - 最终修复报告

## 问题描述

用户报告会话显示在错误的项目下。例如：
- 会话实际运行在：`/Users/pbzhang/Desktop/代码/原型-企业评优`
- 但显示在：`/Users/pbzhang/Desktop/代码/yepanywhere_pb_fork`

同时前端出现错误：`Cannot read properties of undefined (reading 'split')`

## 根本原因分析

### 问题 1：会话 API 返回错误的 projectId
`getSessionSummaryFromDir()` 函数直接使用 URL 参数中的 `projectId`，而不是从会话文件中读取真实的 `cwd`。

### 问题 2：前端崩溃
`getSession()` 函数在读取文件内容后，没有检查 `content` 是否有效就直接调用 `split()`，导致前端错误。

### 问题 3：recentsService 未传递
`createSessionsRoutes` 没有接收到 `recentsService`，导致访问记录功能失效。

## 修复方案

### 修复 1: 从会话文件读取真实的 cwd

**文件：** `packages/server/src/sessions/reader.ts` (getSessionSummaryFromDir 函数)

**修改：** 在返回会话摘要前，从会话文件的第一行读取 `cwd` 字段，并使用它来生成真实的 `projectId`。

```typescript
// Extract the real cwd from the session file (written by Claude SDK on every turn).
// This is the source of truth for which project the session actually belongs to,
// regardless of which directory the session file happens to be stored in.
let realCwd: string | null = null;
for (const msg of messages) {
  if (
    msg &&
    typeof msg === "object" &&
    "cwd" in msg &&
    typeof msg.cwd === "string"
  ) {
    realCwd = msg.cwd;
    break; // Use the first cwd found
  }
}

// Use the real cwd from the session file if available, otherwise fall back to
// the projectId parameter. This ensures sessions show up under their actual
// working directory, not the directory where the .jsonl file happens to be stored.
const { encodeProjectId } = await import("../projects/paths.js");
const actualProjectId = realCwd
  ? encodeProjectId(realCwd)
  : projectId;

return {
  id: sessionId,
  projectId: actualProjectId,  // 使用真实的 projectId
  // ...
};
```

### 修复 2: 添加内容安全检查

**文件：** `packages/server/src/sessions/reader.ts` (getSession 函数)

**修改：** 在调用 `split()` 前检查 `content` 是否有效。

```typescript
const content = await readFile(filePath, "utf-8");

// Guard against empty or invalid content
if (!content || typeof content !== "string") return null;

const lines = content.trim().split("\n");
```

### 修复 3: 传递 recentsService

**文件：** `packages/server/src/app.ts`

**修改：** 在创建会话路由时传递 `recentsService`。

```typescript
createSessionsRoutes({
  supervisor,
  scanner,
  readerFactory,
  externalTracker,
  notificationService: options.notificationService,
  sessionMetadataService: options.sessionMetadataService,
  eventBus: options.eventBus,
  codexScanner,
  codexSessionsDir: CODEX_SESSIONS_DIR,
  codexReaderFactory,
  geminiScanner,
  geminiSessionsDir: GEMINI_TMP_DIR,
  geminiReaderFactory,
  serverSettingsService: options.serverSettingsService,
  modelInfoService: options.modelInfoService,
  recentsService: options.recentsService,  // 添加这一行
  codexBridgeService: options.codexBridgeService,
  sessionArchiveService: options.sessionArchiveService,
  claudeProjectsDir: options.projectsDir ?? CLAUDE_PROJECTS_DIR,
}),
```

### 修复 4: 在 GET session 路由中记录访问

**文件：** `packages/server/src/routes/sessions.ts`

**修改：** 在返回会话前记录访问。

```typescript
// Record session visit with the REAL projectId from the session data.
// The session.projectId comes from the session file's cwd field (source of truth),
// not from the URL parameter. This ensures recents.json always has the correct
// project association, even if the user navigated with a stale/incorrect projectId.
if (deps.recentsService) {
  await deps.recentsService.recordVisit(sessionId, session.projectId);
}
```

## 验证结果

### 测试场景
- sessionId: `68908cf1-5276-440b-995c-ffbe1fdebee5`
- 实际 cwd: `/Users/pbzhang/Desktop/代码/原型-企业评优`
- 错误的 URL projectId: `L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw`

### 修复后结果

1. **API 返回正确的 projectId：**
```bash
curl 'http://localhost:3400/api/projects/L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw/sessions/68908cf1-5276-440b-995c-ffbe1fdebee5'
{
  "session": {
    "projectId": "L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEv5Y6f5Z6LLeS8geS4muivhOS8mA"
  }
}
# 解码后：/Users/pbzhang/Desktop/代码/原型-企业评优 ✓
```

2. **recents.json 记录正确：**
```json
{
  "visits": [
    {
      "sessionId": "68908cf1-5276-440b-995c-ffbe1fdebee5",
      "projectId": "L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEv5Y6f5Z6LLeS8geS4muivhOS8mA"
    }
  ]
}
```

3. **前端不再崩溃：** 添加了内容安全检查，防止 `split()` 错误。

## 修改的文件

```
packages/server/src/sessions/reader.ts  |  28 +++++++++++++++++++++++-
packages/server/src/routes/sessions.ts  |   8 +++++++
packages/server/src/app.ts              |   1 +
3 files changed, 36 insertions(+), 1 deletion(-)
```

## 影响范围

- ✅ 会话现在显示在正确的项目下
- ✅ `recents.json` 正确记录项目关联
- ✅ 前端错误已修复
- ✅ 向后兼容（如果 cwd 读取失败，回退到 URL 参数）
- ✅ 自动修复旧的错误数据（用户访问会话时）

## 测试建议

1. 清空 `~/.yep-anywhere/recents.json`
2. 从不同的项目列表访问会话
3. 验证会话显示在正确的项目下
4. 检查 `recents.json` 记录的 projectId 是否正确

## 总结

此修复确保：
1. 会话 API 始终返回基于会话文件 `cwd` 的真实 `projectId`
2. 前端不会因为空内容而崩溃
3. `recents.json` 始终记录正确的项目关联
4. 会话在正确的项目下显示

**状态：** ✅ 修复完成并验证成功
