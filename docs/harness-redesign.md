# CodePilot Harness 架构重造方案

> 版本 v1.0 ｜ 定位：参照业界 Agent Harness 工程（Claude Code / Codex CLI / OpenHands / Cline）对 CodePilot 做推翻式重设计。不兼容原实现。
>
> 结论先行：**把"编排引擎"从后端搬进插件端，后端退化为 Model Gateway**；用一个 ~300 行的确定性 Agent 循环替换现有的 1259 行 AgentLoop god-class + StateGraph 双轨编排；会话改为事件溯源（append-only JSONL），天然获得恢复/回滚/fork 能力。

---

## 1. 现状诊断（基于真实代码证据）

### 1.1 现状拓扑

```
┌─ plugin (Kotlin, 154 files) ─────────────────────┐
│ IDEA UI(JCEF webui React) · 本地工具(20+)         │
│ indexer(ONNX本地embedding) · mcp客户端 · session  │
│ ⚠ graph/(GraphStateStore.kt) ← 编排逻辑渗入插件    │
└──────────────┬───────────────────────────────────┘
               │ HTTP/SSE + HmacSigner
┌─ backend (Java, 274 files) ───────────────────────┐
│ AgentLoop.java (1259行/123分支) ← god-class        │
│ core/graph/* (15文件 StateGraph 编排)  ← 第二套编排 │
│ agent/workflow/WorkflowService        ← 第三套编排 │
│ PromptBuilder · ContextBudget/Compactor            │
│ PermissionEngine · DoomLoopDetector · GoalJudge    │
│ RAG/FIM/tab/speech/admin/mcp-hub 商城              │
└───────────────────────────────────────────────────┘
```

### 1.2 问题清单

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| P0-1 | **God-class 循环** | `AgentLoop.java` 1259 行、123 处 if/else，混合了：流式解析、工具分发、权限、压缩、doom-loop 恢复、goal 判定、envelope 序列号 | 无法单测（必须起 Spring 容器+真模型）；任何新能力都往里塞 |
| P0-2 | **三套编排机制并存** | ①`AgentLoop` 命令式循环 ②`core/graph/*` StateGraph(intake→intentDispatch→planning→…→finalize) ③`agent/workflow/WorkflowService` | 行为不可预测：同一请求走哪条路径取决于配置组合；README 自述 Deep Research"拓扑已设计未产品化" |
| P0-3 | **工具执行位置颠倒** | AgentLoop 注释自述："LOCAL tools are executed by backend, REMOTE tools are dispatched to plugin via SSE"——触碰用户文件系统的工具竟然在后端执行 | 后端需要持有工作区副本/反向通道；`remoteToolResults: Map<String, Sink>` + `permissionSinks: Map<String, Sink>` 手工关联状态机，超时(TOOL_RESULT_TIMEOUT=5min)、乱序、断连全部成为 bug 面 |
| P0-4 | **无事件溯源** | 会话是 `SessionState`(448行) 内存态对象；README 承认"发版/SSE 硬断场景下的自动续流，设计中" | 崩溃即丢上下文；无法 rewind/fork；审计困难 |
| P0-5 | **模型供应商强绑定** | 直接 import `OpenAiChatModel/OpenAiChatOptions/OpenAiApi`，用 `withFunctions()` 注册工具 | 无法接 Claude/Gemini/本地模型；换供应商要改循环本体 |
| P1-6 | **Prompt 组装碎片化** | `PromptBuilder`(58行) 与 `GraphPromptContextBudget`、`PhaseAwareMemoryLoader`、`PhaseMemoryHelper`、`MemoryContentClassifier` 等 7+ 类共同拼 prompt | prompt 是黑盒，复现一次线上行为要读 10 个类 |
| P1-7 | **插件端编排渗入** | 插件有 `plugin/graph/GraphStateStore.kt`、`ToolResultClassifier.kt`、`LegacyEventAdapter.kt` | 两端各自维护一份"图状态"，协议语义漂移 |
| P1-8 | **测试缺失** | `find backend -name "*Test*.java"` 几乎为空；核心循环零覆盖 | 重构无从下手，只能靠手点 |
| P2-9 | **文档腐烂** | README 引用 `docs/` 与 `doc/`，两者均不存在 | |
| P2-10 | **验证回路薄弱** | 有 `IdeaBuildValidator` 但与循环终止条件无耦合；verify→repair 在 graph 里是可选节点而非强制闭环 | Agent 自以为完成但编译不过 |

---

## 2. 业界 Harness 工程的十条原则（本方案的公理）

从 Claude Code、Codex CLI、OpenHands、Cline、Aider 中提炼：

1. **循环薄如刀**：核心 harness 是一个 ≤300 行、无分支爆炸的确定性 while 循环：`组装上下文 → 调模型 → 解析工具调用 → 权限门 → 执行 → 截断结果 → 回填消息 → 直到 stop_reason`。智能在模型与 prompt 里，不在流程图里。
2. **工具在数据旁边执行**：谁拥有工作区，谁执行工具。编码助手里永远是插件端。服务端永不碰用户文件系统。
3. **一切皆事件**：会话 = append-only 事件日志（JSONL）。UI 是事件的投影，恢复 = 重放，回滚 = 截断，fork = 拷贝前缀。没有第二份"状态"需要同步。
4. **协议先于实现**：定义一版稳定的 NDJSON 事件 schema（typed envelope: seq/id/type/payload），前后端只共享这份契约。杀掉 LegacyEventAdapter 这类补丁层。
5. **模型无关**：harness 只依赖 `ChatModel` 接口（stream(text_delta/tool_call/usage/stop_reason)）。OpenAI/Anthropic/Gemini/Ollama 是适配器。
6. **上下文工程显式化**：system prompt 由具名 section 组装器拼装（identity/rules/skills/env/context），每个 section 有预算，超预算策略显式（truncate/drop/compact）。禁止隐式多类协作拼 prompt。
7. **权限即数据**：权限是声明式规则表（tool × 模式 allow/ask/deny × 路径/命令模式），由独立 PermissionGate 在工具执行前统一裁决；ask 通过 UI 事件回传用户决定。不存在散落的 if-check。
8. **子代理做隔离**：复杂子任务开 SubAgent（独立上下文、受限工具、返回摘要），主循环上下文不被污染。这是控制 context 膨胀的第一手段，比压缩更优先。
9. **Hook 即扩展点**：PreToolUse / PostToolUse / Stop 三类 hook（格式化、lint、禁改文件告警）作为一等公民，替代硬编码的"验证节点"。
10. **可测性优先于功能**：harness 对 `FakeChatModel`（脚本化输出序列）可完整单测；线上流量可录制回放；有任务级评测集（类 SWE-bench-lite 的内部任务集）防止回归。

> 反面教材正是本项目：StateGraph 把"何时调模型"画成拓扑图，而业界共识是——LLM 应用里唯一可靠的编排就是模型自己的 function-calling 循环；图编排适用于确定性业务流（审批流），不适用 agent。

---

## 3. 目标架构

### 3.1 新拓扑

```
┌────────────── plugin（Harness Host，唯一大脑）────────────────┐
│                                                              │
│  ┌── harness-core (纯 Kotlin，无 IDE 依赖，可 JVM 单测) ──┐   │
│  │ AgentHarness.run(task)                                │   │
│  │   loop {                                              │   │
│  │     events += LlmStream(model.chat(ctx))              │   │
│  │     for call in toolCalls:                            │   │
│  │       verdict = permissionGate.check(call)            │   │
│  │       result = toolExecutor.execute(call)  // 本地!    │   │
│  │       ctx.append(truncated(result))                   │   │
│  │     if stopReason == end_turn && verifier.ok() break  │   │
│  │     if tokens > budget: ctx = compactor.compact(ctx)  │   │
│  │   }                                                   │   │
│  │ ContextAssembler · PermissionGate · HookRunner         │   │
│  │ SessionStore(JSONL) · SubagentPool · FakeChatModel     │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌── ide-adapter ──┐  ┌── tools/* ──┐  ┌── ui(webui) ──┐     │
│  │ VFS/Psi/Editor   │  │ fs/shell/   │  │ 订阅事件渲染    │     │
│  │ Build/Test 运行器 │  │ grep/edit   │  │ 审批弹窗       │     │
│  └──────────────────┘  └─────────────┘  └────────────────┘    │
└──────────────┬───────────────────────────────────────────────┘
               │ 唯二依赖：①ChatGateway(补全模型流) ②市场/遥测(异步)
┌─ backend（Model Gateway + 平台服务，无 agent 状态）────────────┐
│ /v1/chat:auth→配额→路由到供应商→透传SSE                        │
│ 模型注册表 · 用量计费 · MCP 市场 · 团队规则下发 · 遥测聚合      │
└──────────────────────────────────────────────────────────────┘
```

**职责铁律**：
- 插件 = harness + 工具运行时 + UI。断网时本地模型(Ollama/LM Studio)仍可全功能工作。
- 后端 = 无状态网关。删除 AgentLoop/StateGraph/workflow/SessionState/PermissionEngine 全部迁走或删除。保留并强化：鉴权、配额计费、多供应商路由、MCP 市场、团队管理、遥测。
- 唯一的跨端实时通道：`POST /v1/chat`（模型补全流）。不再有"后端推工具调用给插件"的反向通道。

### 3.2 核心 API（Kotlin 签名）

```kotlin
// harness-core/AgentHarness.kt —— 整个重设计的核心，目标 ≤300 行
class AgentHarness(
    private val model: ChatModel,            // 模型无关接口
    private val tools: ToolCatalog,          // 名称→Tool
    private val assembler: ContextAssembler, // 具名 section 组装
    private val gate: PermissionGate,
    private val hooks: HookRunner,
    private val session: EventSourcedSession,
    private val budget: ContextBudget,
) {
    fun run(goal: String): Flow<HarnessEvent> = flow {
        session.append(UserMessage(goal))
        var step = 0
        while (step++ < MAX_STEPS) {
            val ctx = assembler.assemble(session.snapshot())
            var pendingTools: List<ToolCallReq> = emptyList()
            model.stream(ctx).collect { ev ->
                when (ev) {
                    is TextDelta -> session.append(AssistantDelta(ev.text))
                    is ToolCall -> { session.append(ev); pendingTools += ev }
                    is StopReason -> { /* end_turn/tool_use */ }
                }
                emit(ev)
            }
            if (pendingTools.isEmpty()) break           // 模型说完了
            for (call in pendingTools) {
                when (gate.check(call)) {
                    Deny -> session.append(ToolResult.denied(call)); continue
                    Ask -> emit(emitAndAwaitApproval(call)) // UI 事件，用户裁决
                    Allow -> {}
                }
                hooks.pre(call)?.let { rewrite -> /* hook 可改写参数 */ }
                val result = tools.execute(call)        // 本地执行，带超时
                val clean = truncate(sanitize(result), budget.toolResultMax)
                hooks.post(call, clean)
                session.append(ToolResult(call.id, clean))
                emit(ToolResultEvent(clean))
            }
            if (budget.exceeded(session)) session.append(Compaction(assembler.compact(session)))
        }
    }
}
```

```kotlin
interface ChatModel {                      // 模型无关（P0-5 的解药）
    fun stream(req: ChatRequest): Flow<ModelEvent>   // TextDelta|ToolCall|StopReason|Usage
}
interface Tool {
    val spec: ToolSpec                     // name/description/jsonSchema（喂给 function-calling）
    suspend fun execute(args: JsonObject): ToolOutput  // stdout/stderr/exitCode/artifact
}
sealed interface HarnessEvent              // NDJSON 协议的唯一来源
```

### 3.3 事件溯源会话（解 P0-4）

```
~/.codepilot/sessions/{sessionId}/
  ├── events.jsonl      # append-only：UserMsg/AssistantMsg/ToolCall/ToolResult/
  │                     # Approval/Compaction/Checkpoint/HookResult...
  ├── meta.json         # 任务、模型、token 统计、状态(running|done|error)
  └── artifacts/        # patch 文件、命令输出大块落盘引用
```

- **恢复** = 读 events.jsonl 重建上下文窗口（最近 N 条 + 压缩摘要），续跑。
- **Rewind/Fork** = 复制 events.jsonl 前缀。UI 时间线直接渲染事件流，替代现有 BranchTimeline 的内存态。
- 写入策略：每事件 fsync 可配；崩溃恢复零丢失。

### 3.4 NDJSON 事件协议（v3，替换现有 envelope v2）

```jsonc
{"seq":42,"t":"text.delta","id":"m1","p":{"text":"let me"}}
{"seq":43,"t":"tool.call","id":"c1","p":{"name":"edit_file","args":{"path":"a.kt"},"origin":"model"}}
{"seq":44,"t":"permission.request","id":"p1","p":{"callId":"c1","rule":"edit_file(outside_workspace)"}}
{"seq":45,"t":"permission.decision","id":"p1","p":{"verdict":"allow","scope":"session"}}
{"seq":46,"t":"tool.result","id":"c1","p":{"ok":true,"truncated":false,"stdoutRef":"artifacts/c1.out"}}
{"seq":47,"t":"step.end","p":{"usage":{"in":12000,"out":800},"compacted":false}}
```

规则：①`seq` 单调，UI 按 seq 断线重放；②大负载落盘传 ref；③所有 id 幂等去重；④协议 JSON Schema 进仓库，两端 CI 校验兼容性。

### 3.5 上下文组装（解 P1-6）

```kotlin
class ContextAssembler(val sections: List<PromptSection>) {
    // sections: SystemIdentity, RulesFiles(CODEPILOT.md 层级合并),
    // Skills(按需渐进披露), WorkspaceEnv(tree/语言/git状态),
    // History(recent+summary), RetrievedContext(索引检索)
    override fun assemble(snap: SessionSnapshot): ChatContext =
        BudgetedComposer(sections, budget).compose(snap)   // 每 section 有 maxTokens 与溢出策略
}
```

单一入口、单一可打印产物：每次请求可 dump 完整 prompt 快照（调试/回归对比的利器）。

### 3.6 子代理与 Hook（对应业界 Task/Hooks）

```kotlin
class SubagentTool(private val factory: (SubagentSpec) -> AgentHarness) : Tool {
    // 独立 session、受限工具集（无 SubagentTool，防递归）、token 上限、
    // 结束仅回传 final summary 到主循环
}
class HookRunner(val pre: List<PreToolUseHook>, val post: List<PostToolUseHook>, val stop: List<StopHook>)
// 内置：ktfmt/format、detekt、deny-edits-on-generated-files；用户可在 settings 注册 shell hook
```

### 3.7 验证闭环（解 P2-10）

- `stop_reason==end_turn` ≠ 任务完成。新增 `CompletionPolicy`：
  - 若本轮产生过 edit → 自动跑 PostToolUse hooks（format/lint）；
  - 若涉及编译单元变更 → 触发增量 build validator，失败则将错误作为 tool result 回灌循环（repair 不再是图里的可选节点，而是循环的自然延续）；
  - 用户可配 `completion=strict|normal|off`。

---

## 4. 关键决策记录（ADR）

| ADR | 决策 | 理由 | 放弃方案 |
|---|---|---|---|
| ADR-1 | 编排整体迁入插件，后端无 agent 状态 | 工具本地性(P0-3)、断网可用、消除跨端关联状态机 | 保持后端编排+双向通道 |
| ADR-2 | 删除 StateGraph/WorkflowService，唯一循环是 AgentHarness | P0-1/P0-2；业界共识 function-calling loop | 图编排 |
| ADR-3 | 会话=JSONL 事件溯源 | 免费获得恢复/回滚/fork/审计 | 内存态 SessionState |
| ADR-4 | 自建 `ChatModel` SPI，Spring AI 仅作供应商适配细节 | P0-5；循环不得感知供应商类型 | 继续 Spring AI 直连类型 |
| ADR-5 | harness-core 纯 Kotlin 库，禁止 Spring/IDE 依赖 | 秒级单测（FakeChatModel 脚本回放）| 放在 bootRun 里测 |
| ADR-6 | 协议 v3 NDJSON + JSON Schema 入库 + 两端 CI 校验 | 杀掉 LegacyEventAdapter 式漂移 | 继续双端各自解释字段 |
| ADR-7 | 权限=声明式规则表 + 统一 Gate；Ask 走协议事件 | 可配置/可审计/团队下发 | 散落 if 判断 |
| ADR-8 | 子代理为一等工具；上下文治理优先"隔离"再"压缩" | 压缩是有损的，隔离是无损的 | 只靠 Compactor |
| ADR-9 | 索引保留插件端 ONNX 本地方案，但接口化为 `CodeSearcher`（grep/结构检索/embedding 三实现可插拔）| 已有资产可留用；避免锁死 embedding 方案 | 后端集中式 RAG |
| ADR-10 | 评测先行：`FakeChatModel` 脚本回放 + 内部任务集（30 个真实修复任务）入 CI | 无评测的重构等于盲飞 | 先重构后补测试 |

---

## 5. 新代码结构

```
plugin/
  harness-core/            # 纯 Kotlin lib（新 module，无 IDE/Spring 依赖）
    harness/  AgentHarness · StepPolicy · CompletionPolicy
    model/    ChatModel · ModelEvent · ChatRequest · providers/(openai|anthropic|gemini|ollama)
    tool/     ToolSpec · ToolCatalog · builtin/(read_file write_file edit_file run_command grep glob)
    context/  ContextAssembler · PromptSection · BudgetedComposer · Compactor
    perm/     PermissionRule · PermissionGate · Verdict
    session/  EventSourcedSession · EventCodec · Rewinder
    subagent/ SubagentTool · SubagentSpec
    hooks/    HookRunner · PreToolUse · PostToolUse
    testfix/  FakeChatModel · ScriptedScenario
  ide-adapter/             # IntelliJ API 适配（VFS/Psi/Editor/Build/Test/终端）
  tools-ide/               # 依赖 IDE 的工具实现（沿用现有 PatchApplier/ThreeWayMerger 精华）
  protocol/v3/             # 事件 schema（Kotlin + JSON Schema 双源）
  webui/                   # React：订阅 NDJSON 渲染（删 BranchTimeline 内存态，改事件投影）
backend/
  gateway/                 # /v1/chat 网关：鉴权/配额/多供应商路由/透传
  marketplace/             # MCP 市场（原 mcp-hub 收编）
  platform/                # 团队/规则下发/遥测聚合/admin
  （删除：AgentLoop、core/graph/**、agent/workflow/**、SessionState、PermissionEngine、
    PromptBuilder 及其协作者、ConversationRunStore 中的编排残留）
```

迁移要点：现有 `PatchApplier/ThreeWayMerger/SmartMatcher/IdeaBuildValidator/GrepSearchTool` 等插件端资产质量尚可，**实现保留、外壳重写**为 `Tool` 接口实现；后端 274 文件预计裁剪至 ~120。

---

## 6. 交付节奏（4 个里程碑，每项含验收标准）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 地基（2 周） | harness-core module + ChatModel SPI + FakeChatModel + 事件溯源 Session + 协议 v3 schema | 用脚本化 FakeModel 跑通"两轮工具调用"场景的单测；events.jsonl 可重放 |
| M2 循环替换（2–3 周） | AgentHarness 正式版 + 8 个内置工具（IDE 适配壳）+ PermissionGate + ContextAssembler/Budget | 内部任务集 30 例跑通 ≥80%（对照人工标注）；AgentLoop.java 删除 |
| M3 闭环与体验（2 周） | CompletionPolicy(build/lint 回灌) + Subagent + Hooks + WebUI 事件投影改造 + 会话恢复/Rewind | kill 进程后重启续跑成功；时间线回滚可用；webui 无 LegacyEventAdapter |
| M4 网关收敛（1–2 周） | backend 裁剪为 gateway/marketplace/platform；多供应商路由；用量计费 | 后端仓库 ≤150 Java 文件且零 agent 状态；Ollama 离线全功能演示 |

节奏纪律：每里程碑结束跑一次内部任务集，分数不升不合入；旧代码只删不改，不做双轨兼容。

## 7. 测试与评测策略

1. **单测**：FakeChatModel 脚本（给定 turn 序列输出文本/工具调用/停止），覆盖：正常完成、工具报错重试、权限拒绝、预算触发压缩、doom-loop（同参重复调用检测）、hook 改写、子代理嵌套。
2. **录制回放**：生产/手测流量录制成 scenario 文件，回归时原样重放 diff 事件流。
3. **任务集评测**：30 个带 golden patch 的真实小任务（bug 修复/特性小改），指标 = 编译通过率 + patch 相似度 + 步数/token 成本；CI 夜跑防回归。
4. **协议一致性**：schema 变更必须过双端 CI（插件 Gradle task + 后端 Gradle task 共享同一 JSON Schema）。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 循环迁入插件后，企业集中管控诉求（审计/限额）受损 | 事件日志本地留存 + 异步批量上报遥测；网关侧仍有配额硬闸 |
| JCEF/webui 大改引入 UI 回归 | webui 改造限定为"事件投影层"，组件级快照测试 |
| 删除 StateGraph 后个别确定性流程（如 onboarding 向导）失去载体 | 该类流程本就不该用 LLM 图，改普通有限状态机代码 |
| FIM/tab 补全等低延迟链路被网关重构波及 | M4 前冻结该链路，仅做路由层适配 |
| 单人理解成本：新抽象一次性落地 | M1 先出 harness-core 的 DESIGN.md + 三个可跑示例 scenario，评审后再铺开 |

---

## 附：立即可以执行的十件事（第一周）

1. 建 `plugin/harness-core` module，落 `ChatModel/Tool/HarnessEvent` 三接口 + FakeChatModel
2. 写第一个 scenario 单测："读文件→编辑→结束"两轮循环
3. 定义 `protocol/v3/events.schema.json` 并让现有 webui 的事件类型生成脚本消费它
4. `events.jsonl` SessionStore 落地 + 重放 API
5. 把 `PatchApplier/ThreeWayMerger` 包成 `Tool` 实现（不动内部逻辑）
6. PermissionGate + 默认规则表（工作区内写=allow，区外/shell=ask，危险 rm=deny）
7. ContextAssembler 最小四 section：Identity/Rules/Workspace/History
8. 删除 `plugin/graph/`、`LegacyEventAdapter.kt`
9. 内部任务集仓库初始化（先收 10 个任务）
10. 给 README 换掉失效的 docs/ 链接，挂上本方案
