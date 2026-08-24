# harness-core 设计说明

> 配套文档：[`harness-redesign.md`](harness-redesign.md)（架构总览 + ADR + 里程碑）、[`backend-strip-plan.md`](backend-strip-plan.md)（后端裁剪）。
> 模块代码：[`plugin/harness-core/`](../plugin/harness-core/)。

## 模块定位

`harness-core` 是一个**纯 Kotlin** 模块（无 Spring、无 IntelliJ Platform、无 Jackson、无 OkHttp 依赖），承载所有 agent 编排能力。它跑在 plugin 端，是 agent 循环的"大脑"。

设计目标（cf. Cursor / Claude Code / Aider 的 harness）：

1. **确定性循环**：`AgentHarness` ≤300 行，编排逻辑不在分支爆炸里。
2. **事件溯源**：会话是 append-only NDJSON 日志（`protocol/v3`），可回放 / rewind / fork。
3. **模型无关**：`ChatModel` SPI，plugin 端可直连供应商或走 backend gateway。
4. **工具可插拔**：`Tool` 接口 + `ToolCatalog`，内置工具在 `tool/builtin/`，外部工具通过 MCP 动态注册。
5. **预算合成**：`BudgetedComposer` 在 token 预算内拼装 system prompt，`Compactor` 在超限时摘要压缩。
6. **subagent 隔离**：`SubagentTool` 在独立 session 里跑子 agent，只把摘要回父会话——这是首选的上下文管理手段。

## 包结构

```
io.codepilot.harness
├── harness/          # AgentHarness + CompletionPolicy + ApprovalHandler
├── session/          # EventSourcedSession + SessionStore
├── event/            # HarnessEvent sealed hierarchy (protocol v3)
├── model/            # ChatModel SPI + ChatRequest/ChatMessage/ModelEvent
├── context/          # ContextAssembler + BudgetedComposer + Compactor + PromptSection
├── hooks/            # HookRunner + PreToolUseHook/PostToolUseHook/StopHook
├── tool/             # Tool + ToolCatalog + ToolExecutor
│   ├── exec/         # ToolExecutor (timeout + retry + parallel)
│   └── builtin/      # EditFileToolExt / ApplyPatchTool / ShellTool / MergeTool / PatchEngine
├── perm/             # PermissionGate + ShellPolicy
├── search/           # CodeSearcher SPI + Bm25Searcher + RipgrepSearcher + Embedder SPI + ...
├── skill/            # SkillManifest + SkillStore + SkillRouter + SkillTool + SkillsPromptSection
├── mcp/              # McpProcessManager + McpSseClient + McpJsonInstaller + McpToolRegistry + McpDynamicTool + McpPermissionGate
├── subagent/         # SubagentSpec + SubagentTool
└── testfix/          # ScenarioLoader (NDJSON 回放回归测试)
```

## 核心循环

```
AgentHarness.run(goal):
  ensureStarted(goal)              # 写 RunStarted + UserMessageAdded
  while step < maxSteps:
    ctx = assembler.assemble(session)      # ContextAssembler + BudgetedComposer
    model.stream(ctx).collect { ev ->      # ChatModel SPI
      TextDelta        -> emit Delta + 累积
      AssistantToolCall -> 暂存到 pendingCalls
      StopReason       -> 记录
    }
    session.append(AssistantMessageAdded(...))
    if pendingCalls.isEmpty():
      d = completion.afterTurn(session)   # CompletionPolicy + StopHooks
      if d is Stop: finish(COMPLETED)
      else: session.append(UserMessageAdded(d.reason))   # 强制再来一轮
      continue
    for call in pendingCalls:
      v = gate.check(call)                 # PermissionGate
      if Deny: record ToolResult(denied)
      elif Ask: ask ApprovalHandler; record PermissionDecisionRecorded
      else:
        pre = hooks.pre(call)             # PreToolUseHook
        if Veto: record ToolResult(vetoed)
        else: out = executor.execute(call) # ToolExecutor (timeout+retry)
             out = hooks.post(call, out)   # PostToolUseHook
             record ToolResult(truncate(out))
    completion.afterTurn(session, hadEdits)   # 跑 stop-hooks（build validator 等）
    compactor.maybeCompact(session)           # 超预算时摘要压缩
```

## Skill / MCP / Search 接入说明

### Skill（`skill/` 包）

- **加载**：`SkillStore` 扫描 `SkillSource`（`{root, source, scope}` 三元组）目录下的 `SKILL.md`，frontmatter 解析 `name/description/hidden`。
- **路由**：`SkillRouter.route(RouteRequest)` 接受 `WorkspaceProbe`（语言/框架/文件路径/关键词/action），用 `TriggerMatcher` 决定哪些 system skills 激活；user skills 经 `UserSkillValidator` 校验（source/scope/sha256/token 预算）。返回 `ActivatedSkill` 列表。
- **注入**：`SkillsPromptSection`（实现 `PromptSection`）由 `BudgetedComposer` 调用，把激活的 skill body 拼进 system prompt。
- **运行时**：`SkillTool`（实现 `Tool`）让 LLM 通过 tool call 显式 list/inspect/activate skill；激活态是 session-scoped。
- **去 Spring**：所有 `@Component`/`@Service` 去除，构造器注入；去 Jackson，用 kotlinx.serialization；去 ConversationRunRequest，用 `RouteRequest` data class 由 IDE adapter 填充。

### MCP（`mcp/` 包）

- **生命周期**：`McpProcessManager`（`AutoCloseable`）管理 stdio + SSE + Streamable HTTP 三种 transport 的 MCP server 进程；30s 健康检查 + 自动重启（最多 3 次）；`McpSseClient` 用 JDK `HttpClient`（不依赖 OkHttp）。
- **安装**：`McpJsonInstaller.parse(raw, defaultName)` 支持 `{"mcpServers":{...}}` / 单 server / direct map 三种格式，返回 `McpEntry` 列表；IDE adapter 负责持久化。
- **工具发现**：`McpToolRegistry.refresh(serverId)` 调 `tools/list`，每个工具包成 `McpDynamicTool`（实现 `Tool`），名字空间为 `mcp.<serverId>.<toolName>`。
- **执行**：`McpDynamicTool.execute(args)` 调 `tools/call`，解析 `content` 数组提取文本；`isError=true` 时返回 `ToolOutput.failure`。
- **权限**：`McpPermissionGate` 包裹 `PermissionGate`，对每个 `(serverId, toolName)` 首次调用返回 `Ask`，IDE adapter 弹窗 → `ApprovalRequest.resolver(granted)` → 记住 allow/deny。`checkSuspend` 提供挂起版给协程循环用。
- **去 IntelliJ**：`@Service(Level.APP)` + `Disposable` → `AutoCloseable`；`com.intellij.openapi.diagnostic.Logger` → slf4j；`LocalMarketplaceStore.McpTransport` → 本地 `McpProcessManager.Transport` enum。

### Search（`search/` 包）

- **SPI**：`CodeSearcher` 提供 `grep(pattern, opts)` 和 `semantic(query, topK)` 两个方法；`Embedder` 提供 `embed(text): FloatArray`。
- **实现 1 — Bm25Searcher**：纯 JDK BM25 + 稀疏 TF-IDF 余弦 + 符号/路径 boost + 自适应深度。下沉自 `LocalSearchEngine`（631 行 → 算法部分原样保留）。还提供 `adaptiveSearch`（按查询复杂度选 topK 与策略）。
- **实现 2 — RipgrepSearcher**：有 `rg` 则走 `rg --json` 子进程（解析 `{"type":"match"}` 行）；无则回退到 `Bm25Searcher.grep`。`findRipgrep()` 自动探测。
- **Embedder**：`TfidfEmbedder`（char n-gram hash + L2 normalize，纯 JDK 兜底）→ `PythonEmbedder`（sentence-transformers 子进程，常驻，JSON over stdin/stdout，有则用）→ `OnnxModelCache`（ONNX 模型下载缓存，SHA-256 校验）。
- **PathFuzzyMatcher**：Levenshtein + 路径相似度（exact / filename / prefix / subsequence / fuzzy），下沉自 `SmartMatcher` 的纯算法部分。

## IDE adapter 接入

harness-core 不直接调 IntelliJ API。IDE adapter（`plugin/src/main/kotlin/io/codepilot/plugin/...`）负责：

- 构造 `WorkspaceScope`（`tool/WorkspaceScope.kt`）限制文件读写范围
- 把 `Bm25Searcher` / `RipgrepSearcher` 桥接到 `LocalSearchEngine` 的 PSI 索引（如果仍用 IDE 索引）
- 提供 `PermissionGate.ApprovalHandler` 实现（弹 `Messages.showOkCancelDialog`）
- 把 `McpPermissionGate.ApprovalRequest` 接到 `McpConfirmGate` UI
- 把 `RunFinished` 等 event 转发到 `EventBus`（SSE 推到 WebUI）

## 测试

- `harness-core/src/test/`：纯 JVM 单测，无 IDE 启动。`FakeChatModel` + `ScenarioLoader` 让录制流量可回放。
- `protocol/v3/fixtures/*.jsonl`：golden NDJSON 样本，`validateEventsJson` Gradle task 校验 `type` 白名单 + 必需字段。
