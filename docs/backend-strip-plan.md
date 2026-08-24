# Backend 裁剪清单（harness-core 迁移）

> 目标：后端退化为 Model Gateway（ADR-1），删除所有 agent 编排能力。
> 依据：`docs/harness-redesign.md` §5；`plugin/harness-core/` 已落地 Kotlin 替代实现。

## 删除原则

1. **先重写 ConversationController** → 纯 `/v1/chat` 透传网关（不持会话状态，不调度工具，只转发 LLM 流）。删编排类前必须先做这步。
2. **分批删，每批后跑 `./gradlew :codePilot-core:compileJava`** 确认无悬挂引用。
3. **静态耦合先解**：`ToolSchemaRegistry` ↔ `MemoryContentClassifier`（删 graph/ 时一并删 ToolSchemaRegistry）。
4. **资源迁移**：`skills/*.yaml` 从 `codePilot-core/src/main/resources/skills/` 迁到 `codePilot-mcp-hub/src/main/resources/market-skills/`（市场服务端保留）。
5. **保留职责**：SignatureService（市场验签）、HmacSignatureWebFilter/HmacSigner（网关安全）、TokenMeter（计费）、MemoryService（团队记忆下发，可选保留）。

## 删除批次（按依赖顺序）

### 批次 1 — 无 controller 直依赖的编排残留（先删最安全）

| 类别 | 路径（相对 backend/） |
|---|---|
| StateGraph 第二套编排 | `codePilot-core/src/main/java/io/codepilot/core/graph/**`（18 文件） |
| GraphAction 节点 | `codePilot-core/.../core/graph/actions/{ContextSplitAction,MemoryLoadAction,SummarizeAction,DynamicPlanExpandAction}.java` |
| Graph 测试 | `codePilot-core/src/test/java/io/codepilot/core/graph/**`（5 文件） |
| agent/workflow | `codePilot-core/.../core/agent/workflow/WorkflowService.java` |
| agent/{distill,dream,evolution,maxmode} | `codePilot-core/.../core/agent/{distill,dream,evolution,maxmode}/*.java` |
| 静态工具目录（与 graph 静态耦合） | `codePilot-core/.../core/tool/ToolSchemaRegistry.java` |
| 工具记忆 profile | `codePilot-core/.../core/tool/ToolMemoryProfile.java` |

**删后验证**：`./gradlew :codePilot-core:compileJava` 应只剩 AgentLoop/Factory → WorkflowService 的悬挂引用（批 2 解决）。

### 批次 2 — AgentLoop god-class 及直接协作者

| 类别 | 路径 |
|---|---|
| AgentLoop + Factory | `codePilot-core/.../core/agent/AgentLoop.java`、`AgentLoopFactory.java`、`AgentDefinition.java`、`AgentRegistry.java`、`SessionEnvironment.java` |
| agent/tool records | `codePilot-core/.../core/agent/tool/{ToolCall,ToolResult}.java` |
| GoalJudge | `codePilot-core/.../core/agent/goal/{GoalJudge,GoalCondition}.java` |
| session/checkpoint | `codePilot-core/.../core/session/checkpoint/{CheckpointWriter,CycleManager}.java` |
| session/recovery | `codePilot-core/.../core/session/recovery/DoomLoopDetector.java` |
| session/subagent | `codePilot-core/.../core/session/subagent/SubagentService.java` |
| session/result | `codePilot-core/.../core/session/result/ToolResultSanitizer.java` |
| session/context | `codePilot-core/.../core/session/context/{ContextBudget,ContextCompactor,ContextConfig}.java` |
| session/prompt + layer | `codePilot-core/.../core/session/prompt/{PromptBuilder,PromptContext,PromptLayer,PromptResourceLoader}.java` + `layer/*.java`（11 文件） |
| permission | `codePilot-core/.../core/permission/{PermissionEngine,PermissionRuleset,PermissionRule}.java` |
| 顶层 context 编排残留 | `codePilot-core/.../core/context/{ContextOrchestrator,ContextBudgeter}.java` |

### 批次 3 — Schema 工具族（29 个）

| 类别 | 路径 |
|---|---|
| 工具注册基础设施 | `codePilot-core/.../core/session/tool/{ToolRegistry,ToolDefinition,ToolExecutor,ToolConfig}.java` |
| 文件工具 | `FileReadTool,FileListTool,FileSearchTool,FileGrepTool,FileOutlineTool,FileCreateTool,FileWriteTool,FileReplaceTool,FileDeleteTool,FileMoveTool,FileApplyPatchTool.java` |
| Shell 工具 | `ShellExecTool,ShellSessionTool.java` |
| 代码工具 | `CodeOutlineTool,CodeSymbolTool,CodeUsagesTool.java` |
| IDE 工具 | `IdeOpenFileTool,IdeDiagnosticsTool,IdeApplyPatchTool,IdeShadowValidateTool.java` |
| Notepad | `NotepadReadTool,NotepadWriteTool.java` |
| 其他 | `AskUserTool,CommitTool,TaskSubagentTool.java` |
| 任务工具族 | `codePilot-core/.../core/task/{TaskCreateTool,TaskListTool,TaskUpdateTool,TaskService,TaskInfo}.java` |

### 批次 4 — SessionState + envelope + 消息持久化

| 类别 | 路径 |
|---|---|
| SessionState v2 | `codePilot-core/.../core/session/{SessionState,SessionStatus,StreamEvent,Message,EnvelopeEvent,EnvelopeStore}.java` |

**保留**：`SessionService/SessionRepository/MessageRepository/RunRequest`（需先重写 ConversationController 再评估，见"需谨慎评估"）。

### 批次 5 — MCP 后端集成 + Skill 后端编排

| 类别 | 路径 |
|---|---|
| MCP 后端 | `codePilot-core/.../core/mcp/{McpToolExecutor,McpToolBridge}.java` |
| Skill 后端编排 | `codePilot-core/.../core/skill/{SystemSkillLoader,SkillService,SkillRouter,SkillTool,SkillManifest,SkillInfo,TriggerMatcher,UserSkillValidator,WorkspaceProbe,ActivatedSkill}.java` |
| Skill 测试 | `codePilot-core/src/test/java/io/codepilot/core/skill/TriggerMatcherTest.java` |

### 批次 6 — Memory 后端（可选）

| 类别 | 路径 | 备注 |
|---|---|---|
| 团队记忆 | `codePilot-core/.../core/session/memory/{MemoryService,DatabaseMemoryService,MemoryEntry}.java` | 若后端保留团队记忆下发，留接口删实现 |
| MemoryTool | `codePilot-core/.../core/session/memory/MemoryTool.java` | harness-core 已有本地 MemoryTool |

## 需谨慎评估（保留，但需重写）

| 文件 | 为什么保留 | 重写方向 |
|---|---|---|
| `codePilot-api/.../ConversationController.java` | 前端入口 | 重写为纯 `/v1/chat` 透传：只接受 `{messages, model, tools}` → 转发 LLM stream → 返回 NDJSON；不持会话状态、不调度工具 |
| `codePilot-core/.../core/session/SessionService.java` | 控制器入口 | 重写为无状态：不再装配 AgentLoopFactory |
| `codePilot-core/.../core/session/{SessionRepository,MessageRepository,RunRequest}.java` | DB 审计表 | 视后端是否保留会话审计表；若留，重写为纯审计写入 |
| `codePilot-core/.../core/context/TokenMeter.java` | 网关计费 | 保留，用于 LLM 调用计费 |
| `codePilot-core/.../core/context/LazyRefResolver.java` | 懒加载 | 评估是否网关仍需 |
| `codePilot-core/.../core/rag/ServerToolExecutor.java` | RAG 检索 | 剥离对 AgentLoop 的依赖后保留（若后端保留 RAG） |
| `codePilot-mcp-hub/.../mcp/SkillController.java` | 市场 API | 保留；资源加载从 classpath:skills/ 改为 market 仓库 |
| `codePilot-mcp-hub/.../mcp/SkillClasspathArchiveService.java` | 市场 ZIP 打包 | 重写资源加载路径 |

## SignatureService 强化

`codePilot-mcp-hub/.../mcp/SignatureService.java` 已正确接真实 PublicKey（`X509EncodedKeySpec` + `KeyFactory` + `Signature.verify`），但 `verifyOfficialSignature()` 是空实现：

```java
// 第 61 行
// TODO: Load official public key from config
return true;  // ← 必须修复
```

**修复方案**：从 `application.yml` 注入官方公钥（Base64 X.509），加载到 `KeyFactory`，在 `verifyOfficialSignature` 中走与 `verifySignature` 相同的验签流程。公钥不入仓库，通过环境变量 `CODEPILOT_OFFICIAL_PUBKEY` 注入。

## Backend ChatModel SPI 适配器层

后端不再做编排，但仍需对接多个 LLM 供应商（OpenAI、Anthropic、阿里 DashScope）。建议自建 SPI：

```
codePilot-core/.../core/model/
├── ChatModel.java          // SPI 接口：stream(ChatRequest): Flux<ChatEvent>
├── ChatRequest.java        // messages + tools + model + maxTokens + temperature
├── ChatEvent.java           // sealed: Delta | ToolCall | Stop | Error
├── ChatModelProvider.java  // 工厂：根据 model 名选适配器
└── adapters/
    ├── OpenAiChatModel.java   // Spring AI OpenAi
    ├── AnthropicChatModel.java // Spring AI Anthropic
    └── DashScopeChatModel.java // 阿里通义
```

**对齐 harness-core**：`harness-core/model/ChatModel.kt` 已定义同名 SPI；后端 SPI 是它的"服务端版"，签名一致以便 plugin 直接走 backend 网关或直连供应商。

## 执行顺序（与里程碑对齐）

1. **M2 §1**：重写 ConversationController 为透传网关（最小可工作：只支持 OpenAI 适配器）。
2. **M2 §2**：批次 1 删除（graph + workflow + distill/dream/evolution/maxmode + ToolSchemaRegistry）。
3. **M2 §3**：批次 2 删除（AgentLoop + 协作者 + permission + prompt layer）。
4. **M2 §4**：批次 3 删除（schema 工具族 29 个）。
5. **M3 §1**：批次 5 删除（MCP + Skill 后端）。
6. **M3 §2**：批次 4 删除（SessionState v2）。
7. **M3 §3**：SignatureService 修复 + ChatModel SPI 适配器层。
8. **M3 §4**：批次 6 评估（Memory 后端）。

每批删完跑 `./gradlew :codePilot-core:compileJava` + `:codePilot-core:test` 确认无回归。
