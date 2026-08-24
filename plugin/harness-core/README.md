# harness-core

> 纯 Kotlin agent 编排内核。无 Spring、无 IntelliJ Platform、无 Jackson、无 OkHttp 依赖。
> 详细设计见 [`docs/harness-design.md`](../../docs/harness-design.md)。

## 模块职责

承载所有 agent 编排能力，跑在 plugin 端：

- **确定性循环**：`AgentHarness` ≤300 行，事件溯源，模型无关
- **工具循环**：`ToolExecutor`（超时 + 重试 + 可选并行）、`ToolCatalog`、`HookRunner`（pre/post/stop hooks）
- **预算合成**：`BudgetedComposer` 在 token 预算内拼 prompt，`Compactor` 在超限时摘要压缩
- **subagent**：`SubagentTool` 在独立 session 跑子 agent，只把摘要回父会话
- **search**：`Bm25Searcher` / `RipgrepSearcher` / `TfidfEmbedder` / `PythonEmbedder` / `OnnxModelCache` / `PathFuzzyMatcher`
- **skill**：`SkillStore` / `SkillRouter` / `SkillTool` / `SkillsPromptSection`
- **mcp**：`McpProcessManager` / `McpSseClient` / `McpJsonInstaller` / `McpToolRegistry` / `McpDynamicTool` / `McpPermissionGate`

## 包结构

```
io.codepilot.harness
├── harness/      # AgentHarness + CompletionPolicy + ApprovalHandler
├── session/      # EventSourcedSession + SessionStore
├── event/        # HarnessEvent sealed hierarchy (protocol v3)
├── model/        # ChatModel SPI + ChatRequest/ChatMessage/ModelEvent
├── context/      # ContextAssembler + BudgetedComposer + Compactor + PromptSection
├── hooks/        # HookRunner + PreToolUseHook/PostToolUseHook/StopHook
├── tool/         # Tool + ToolCatalog + ToolExecutor
│   ├── exec/     # ToolExecutor (timeout + retry + parallel)
│   └── builtin/  # EditFileToolExt / ApplyPatchTool / ShellTool / MergeTool / PatchEngine
├── perm/         # PermissionGate + ShellPolicy
├── search/       # CodeSearcher SPI + Bm25Searcher + RipgrepSearcher + Embedder SPI + ...
├── skill/        # SkillManifest + SkillStore + SkillRouter + SkillTool + SkillsPromptSection
├── mcp/          # McpProcessManager + McpSseClient + McpJsonInstaller + McpToolRegistry + ...
├── subagent/     # SubagentSpec + SubagentTool
└── testfix/      # ScenarioLoader (NDJSON 回放回归测试)
```

## Skill / MCP / Search 接入

### Skill

```kotlin
val store = SkillStore(listOf(
    SkillStore.SkillSource(root = Path.of(".codepilot/skills"), source = "user", scope = "project"),
    // ... bundled skills
))
val matcher = TriggerMatcher()
val userValidator = UserSkillValidator()
val router = SkillRouter(store, matcher, userValidator)

val section = SkillsPromptSection(router) {
    SkillRouter.RouteRequest(
        mode = "AGENT",
        probe = WorkspaceProbe.build(
            mode = "AGENT",
            filePaths = openFilePaths,
            userInput = currentUserMessage,
        ),
        userSkills = listOf(...),
        projectRootHash = "...",
        allowedTools = setOf("read_file", "edit_file"),
    )
}
```

把 `section` 加进 `ContextAssembler` 的 `sections` 列表即可。LLM 也可通过 `SkillTool`（实现 `Tool`）显式 `op=list|inspect|activate`。

### MCP

```kotlin
val manager = McpProcessManager()  // AutoCloseable
manager.start("filesystem", McpProcessManager.McpLaunchSpec(
    id = "filesystem", argv = listOf("npx", "@modelcontextprotocol/server-filesystem", "/workspace"),
))
val registry = McpToolRegistry(manager)
val tools = registry.refresh("filesystem")  // 调 tools/list，每个 tool 一个 McpDynamicTool

// 把 tools 加进 ToolCatalog；首次调用会触发 McpPermissionGate.Ask
val mcpGate = McpPermissionGate(underlyingGate)
```

支持三种 transport：`STDIO`（本地进程）、`SSE`（远程）、`STREAMABLE_HTTP`（远程）。`McpJsonInstaller.parse(raw)` 支持 `{"mcpServers":{...}}` / 单 server / direct map 三种 JSON 格式。

### Search

```kotlin
val searcher = RipgrepSearcher(root = workspaceRoot)  // 有 rg 用 rg，无则回退 Bm25
searcher.indexChunks(chunks)  // 仅 Bm25Searcher 有此方法；RipgrepSearcher 透传给 fallback

val hits = searcher.semantic("where is the auth middleware?", topK = 20)
val grepHits = searcher.grep("fun authenticate", GrepOpts(caseSensitive = true))

// Embedder 可插拔：Python 优先，Tfidf 兜底
val embedder: Embedder = if (pythonEmbedder.available) pythonEmbedder else TfidfEmbedder()
val vec = embedder.embed("query text")
```

## 协议

会话事件以 NDJSON 追加到 `.codepilot/events.jsonl`，schema 见 [`protocol/v3/events.schema.json`](../../protocol/v3/events.schema.json)，说明见 [`protocol/v3/events.md`](../../protocol/v3/events.md)。

## 测试

```bash
./gradlew :plugin:harness-core:test
./gradlew :plugin:validateEventsJson   # 校验 protocol/v3/fixtures/*.jsonl
```

`FakeChatModel` + `ScenarioLoader` 让录制的 LLM 流量可回放做回归测试。
