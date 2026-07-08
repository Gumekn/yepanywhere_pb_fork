# 项目 ID 不匹配问题修复报告

## 问题描述

在 Yep Anywhere 中，会话列表的项目归属显示与实际运行的项目不一致。例如：
- 会话实际在 `/Users/pbzhang/Desktop/代码/原型-企业评优` 运行
- 但显示归属于 `/Users/pbzhang/Desktop/代码/yepanywhere_pb_fork` 项目

### 根本原因

1. **会话 API 返回错误的 projectId**
   - `getSessionSummaryFromDir()` 函数直接使用 URL 参数中的 `projectId`
   - 没有验证 URL 的 `projectId` 是否与会话文件中的 `cwd` 一致
   - 当用户从错误的项目列表点击会话时，URL 中的 `projectId` 是错误的

2. **recents.json 记录错误的关联**
   - `RecentsService.recordVisit()` 依赖会话 API 返回的 `projectId`
   - 因为 API 返回错误的 `projectId`，所以 `recents.json` 也记录了错误的关联
   - 导致会话在错误的项目下显示

### 数据流分析

**修复前的错误流程：**
```
用户点击会话
  ↓
GET /api/projects/:projectId/sessions/:sessionId
  ↓
getSessionSummaryFromDir() 
  → 直接返回 URL 中的 projectId (错误！)
  ↓
RecentsService.recordVisit(sessionId, 错误的projectId)
  ↓
recents.json 记录错误的关联
  ↓
会话显示在错误的项目下
```

**修复后的正确流程：**
```
用户点击会话
  ↓
GET /api/projects/:projectId/sessions/:sessionId
  ↓
getSessionSummaryFromDir()
  → 从会话文件读取 cwd
  → 使用 encodeProjectId(cwd) 作为真实的 projectId
  ↓
RecentsService.recordVisit(sessionId, 真实的projectId)
  ↓
recents.json 记录正确的关联
  ↓
会话显示在正确的项目下
```

## 修复方案

### 1. 修改 `getSessionSummaryFromDir()` 使用会话文件中的 cwd

**文件：** `packages/server/src/sessions/reader.ts`

**修改前：**
```typescript
export function getSessionSummaryFromDir(
  sessionDir: string,
  urlProjectId: UrlProjectId,
): SessionSummary {
  const sessionId = basename(sessionDir, ".jsonl");
  return {
    sessionId,
    projectId: urlProjectId,  // 直接使用 URL 参数（错误！）
    ...
  };
}
```

**修改后：**
```typescript
export function getSessionSummaryFromDir(
  sessionDir: string,
  urlProjectId: UrlProjectId,
): SessionSummary {
  const sessionId = basename(sessionDir, ".jsonl");
  
  // Read the session file to extract the REAL cwd (source of truth)
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  let realProjectId = urlProjectId;
  
  try {
    const content = readFileSync(sessionFile, "utf-8");
    const firstLine = content.split("\n")[0];
    if (firstLine) {
      const parsed = JSON.parse(firstLine);
      if (parsed.cwd && typeof parsed.cwd === "string") {
        realProjectId = encodeProjectId(parsed.cwd);
      }
    }
  } catch (error) {
    console.warn(`Failed to read cwd from ${sessionFile}:`, error);
  }
  
  return {
    sessionId,
    projectId: realProjectId,  // 使用真实的 projectId
    ...
  };
}
```

**关键改进：**
- 从会话文件的第一行读取 `cwd` 字段（真实来源）
- 将 `cwd` 编码为 `projectId`
- 如果读取失败，回退到 URL 参数（向后兼容）

### 2. 在 GET session 路由中记录访问

**文件：** `packages/server/src/routes/sessions.ts`

在 GET `/api/projects/:projectId/sessions/:sessionId` 路由中添加：

```typescript
// Record session visit with the REAL projectId from the session data.
// The session.projectId comes from the session file's cwd field (source of truth),
// not from the URL parameter. This ensures recents.json always has the correct
// project association, even if the user navigated with a stale/incorrect projectId.
if (deps.recentsService) {
  await deps.recentsService.recordVisit(sessionId, session.projectId);
}
```

**关键点：**
- 使用 `session.projectId`（来自会话文件的 cwd）
- 不使用 URL 参数中的 `projectId`
- 确保 `recents.json` 始终记录正确的关联

### 3. 传递 recentsService 到路由

**文件：** `packages/server/src/app.ts`

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

## 修复效果验证

### 测试场景

**会话信息：**
- sessionId: `68908cf1-5276-440b-995c-ffbe1fdebee5`
- 实际 cwd: `/Users/pbzhang/Desktop/代码/原型-企业评优`
- 错误的 URL projectId: `L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw`
  （解码后：`/Users/pbzhang/Desktop/代码/yepanywhere_pb_fork`）

### 修复前

```bash
# API 返回错误的 projectId
curl 'http://localhost:3400/api/projects/L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw/sessions/68908cf1-5276-440b-995c-ffbe1fdebee5'
{
  "session": {
    "projectId": "L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw"  // 错误！
  }
}

# recents.json 记录错误的关联
cat ~/.yep-anywhere/recents.json
{
  "visits": [
    {
      "sessionId": "68908cf1-5276-440b-995c-ffbe1fdebee5",
      "projectId": "L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw"  // 错误！
    }
  ]
}
```

### 修复后

```bash
# API 返回正确的 projectId（来自会话文件的 cwd）
curl 'http://localhost:3400/api/projects/L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw/sessions/68908cf1-5276-440b-995c-ffbe1fdebee5'
{
  "session": {
    "projectId": "L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEv5Y6f5Z6LLeS8geS4muivhOS8mA"  // 正确！
  }
}

# 解码后：/Users/pbzhang/Desktop/代码/原型-企业评优 ✓

# recents.json 记录正确的关联
cat ~/.yep-anywhere/recents.json
{
  "visits": [
    {
      "sessionId": "68908cf1-5276-440b-995c-ffbe1fdebee5",
      "projectId": "L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEv5Y6f5Z6LLeS8geS4muivhOS8mA"  // 正确！
    }
  ]
}
```

## 修改的文件

1. `packages/server/src/sessions/reader.ts`
   - 修改 `getSessionSummaryFromDir()` 从会话文件读取 `cwd`

2. `packages/server/src/routes/sessions.ts`
   - 在 GET session 路由中添加 `recordVisit()` 调用

3. `packages/server/src/app.ts`
   - 将 `recentsService` 传递给 `createSessionsRoutes()`

## 向后兼容性

- 如果会话文件读取失败，回退到使用 URL 参数中的 `projectId`
- 不会影响现有的功能
- 旧的 `recents.json` 数据会在用户访问会话时自动修复

## 测试建议

1. **单元测试：**
   - 测试 `getSessionSummaryFromDir()` 正确读取 `cwd`
   - 测试读取失败时的回退逻辑

2. **集成测试：**
   - 从错误的项目列表点击会话
   - 验证 API 返回正确的 `projectId`
   - 验证 `recents.json` 记录正确的关联

3. **手动测试：**
   - 清空 `~/.yep-anywhere/recents.json`
   - 访问多个不同项目的会话
   - 检查会话是否显示在正确的项目下

## 总结

这个修复确保了：
1. ✅ 会话 API 始终返回真实的 `projectId`（基于会话文件的 `cwd`）
2. ✅ `recents.json` 始终记录正确的项目关联
3. ✅ 会话在正确的项目下显示
4. ✅ 向后兼容，不影响现有功能
5. ✅ 自动修复旧的错误数据

修复已在开发模式下验证成功。
