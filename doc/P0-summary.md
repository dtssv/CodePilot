# P0 阶段总结(2026-05-17)

> 本文为 CodePilot WebUI 对齐 Cursor 计划中 **P0 阶段** 的实施总结。
> 详细设计见 `doc/01-event-protocol.md`、`doc/02-tool-call-card.md`、
> `doc/03-apply-workflow.md`、`doc/04-inline-edit.md`。

---

## 1. 完成情况

### 1.1 P0-01 结构化事件协议 ✅

| 模块 | 路径 | 说明 |
|---|---|---|
| Kotlin Envelope | `plugin/.../protocol/EventEnvelope.kt` | `seq/turnId/stepId/parentStepId/ts/type/payload` 完整定义 + `EventTypes/StepKinds/Statuses` 常量。 |
| Kotlin EventBus | `plugin/.../protocol/EventBus.kt` | Project 服务,生成单调 `seq`、5000 条 ring buffer、`replaySince`、`startTurn/endTurn/startStep/endStep/textDelta/toolCall/toolProgress/toolResult` 便捷方法。 |
| Legacy 适配器 | `plugin/.../protocol/LegacyEventAdapter.kt` | 把现有 `ConversationClient.Listener` 回调翻译成 envelope,保留旧通道不动。 |
| WebUI 协议层 | `plugin/webui/src/state/{events.ts,turnReducer.ts,chatStore.ts}` | 强类型 envelope、纯函数 reducer、Context store + 重排序窗口、`installChatV2Bridge` 自动接入。 |
| 灰度开关 | `localStorage['codepilot.protocol.v2']` | `isV2Enabled()` 控制 v2 ChatView 是否启用。 |
| 测试 | `state/turnReducer.test.ts` | 顺序/乱序/replay 路径自检。 |

**后端依赖**:无。Envelope 是「插件 → WebUI」的内部协议,完全由 LegacyEventAdapter 从既有 SSE 事件派生。

---

### 1.2 P0-02 工具调用结构化卡片 ✅

| 模块 | 路径 |
|---|---|
| 后端分类器 | `plugin/.../protocol/ToolResultClassifier.kt` |
| WebUI 类型 | `plugin/webui/src/components/tools/v2/types.ts`(`ToolResultPayload` 判别联合) |
| ToolCallCard | `tools/v2/ToolCallCard.tsx` |
| 子渲染器 | `ToolArgsView.tsx` + `ToolResultView.tsx`(fs.read/shell/grep/error 等) |
| Rerun 通道 | `CefChatPanel.handleToolRerun` + `sendToPlugin('tool.rerun')` |
| ChatViewV2 | `tools/v2/ChatViewV2.tsx` |
| 测试 | `tools/v2/toolResult.test.ts` |

**后端依赖**:无。所有分类逻辑在插件本地完成,Rerun 只是本地重放工具调用、不回喂模型。

---

### 1.3 P0-03 Hunk 级 Apply 工作流 ✅

| 模块 | 路径 |
|---|---|
| 行级 LCS Diff | `plugin/.../apply/DiffUtil.kt`(纯 Kotlin,无 IDE 依赖,7 单测全过) |
| 暂存服务 | `plugin/.../apply/PatchStaging.kt`(`stage/setHunkStatus/applyFile/applyAll/rejectFile/reapply/undoTurn`) |
| Tool 路由 | `tools/ToolDispatcher.tryStage` 在 `stageBeforeApply=true` 时拦截 fs.write/create/replace/delete |
| 设置开关 | `settings/CodePilotSettings.stageBeforeApply` |
| 7 个 endpoint | `CefChatPanel.handleApply*` |
| WebUI store | `state/pending.ts`(订阅 envelope + `apply.list_response`) |
| WebUI 组件 | `components/apply/{ChangePanel,FileChangeCard,HunkView}.tsx` |
| 事件类型 | `EventTypes.PENDING_UPDATE / APPLY_RESULT` |

**后端依赖**:无。整个 staging 工作流在客户端完成,绕过现有 `PatchApplier` 的即时写盘。

---

### 1.4 P0-04 Cmd+K 内联编辑 + Tab 反馈 ✅

| 模块 | 路径 |
|---|---|
| 4 个 Action | `inline/InlineEditAction / Accept / Reject / RewriteInlineEditAction` |
| 控制器 | `inline/InlineEditController`(弹窗、SSE、流式 buffer、Accept 经 PatchStaging) |
| Inlay 渲染 | `inline/InlineDiffInlayRenderer`(绿色块状 inlay,5 态状态条) |
| Tab 统计 | `completion/TabFeedback`(Application 服务,接入既有 `CodePilotInlineCompletionProvider`) |
| 事件类型 | `INLINE_OPEN/DELTA/DONE/ACCEPT/REJECT/ERROR` + `TAB_SUGGEST/ACCEPT/DISMISS` |
| Tab WebUI | `components/inline/TabSettingsPanel.tsx` |
| Timeline | `components/inline/InlineEditTimeline.tsx` |
| 测试 | `TabFeedbackTest.kt`(4 用例) |
| 快捷键 | `Ctrl/Cmd+K`、`Alt+Y/N/R` 已注册到 `plugin.xml` |

**后端依赖**:`/v1/actions/inline-edit`SSE 端点。

---

## 2. 服务端接口完备性核查

### 2.1 现状(已验证)

| 能力 | 服务端 endpoint | 验证结果 |
|---|---|---|
| Inline Edit | `POST /v1/actions/inline-edit` | ✅ `ActionController.java:163-173` 已注册;`InlineEditRequest` 字段(`sessionId/modelId/modelSource/selection/instruction/language/filePath`)与插件 payload 一致。 |
| Inline Edit Prompt | `prompts/action.inline-edit.txt` | ✅ 存在;输出严格 JSON `{oldText,newText,explanation}`。 |
| SSE 事件格式 | `SseEvents.DELTA` 等 | ✅ `ConversationService.run` 产生 `delta`(`{text}`)、`done`(`{reason}`)、`error`(`{code,message}`)— 与插件 `EventSourceListener.onEvent` 期望一致。 |
| 工具回执 | `POST /v1/conversation/tool-result` | ✅ 既有,P0-02 Rerun 通道不调用此端点(本地重放)。 |
| 既有 SSE 通道 | `POST /v1/conversation/run/resume` | ✅ 既有,P0-01 LegacyEventAdapter 直接复用其事件。 |

### 2.2 已修复的客户端不一致

- **`InlineEditController.streamReplacement`**:payload 字段名从 `context` → `selection`,匹配服务端 `InlineEditRequest.selection`。
- **`InlineEditController.finishStream`**:新增 `extractReplacement`,正确解析服务端返回的 JSON `{oldText,newText,explanation}`,优先按 `oldText` 在原选区内做局部替换(若 oldText==full selection 则整段替换),JSON 解析失败 fallback 到原 `stripCodeFences`。

### 2.3 结论

**P0 阶段所需服务端接口已 100% 完备,无需新增后端代码。** 客户端两处不一致已修复。

---

## 3. 集成挂载现状

P0 全部以**灰度/Opt-in**形式落地,不影响默认行为:

| 特性 | 启用方式 |
|---|---|
| v2 envelope 协议 | `localStorage['codepilot.protocol.v2']='1'` |
| Hunk 暂存 | 设置面板 `stageBeforeApply=true` |
| Cmd+K 内联编辑 | 始终启用(直接快捷键触发) |
| Tab 反馈 | 始终采集(由 `CodePilotInlineCompletionProvider` 隐式触发) |

新组件(`ChatViewV2`、`ChangePanel`、`TabSettingsPanel`、`InlineEditTimeline`)**尚未挂载到 `App.tsx`** — 这是 P0 阶段唯一未完成的「胶水代码」,留给 `wireup` 任务统一处理。

---

## 4. 风险与待办

### 4.1 已知风险

1. ✅ **Inline Edit 输出协议已修复**:服务端 `action.inline-edit.txt` 已从 JSON 改为 raw replacement + `<<<EXPLAIN>>>` 哨兵协议;客户端 `InlineEditController.extractReplacement` 已按哨兵切分,旧 JSON 仅作为兼容 fallback。
2. ✅ **Inline Edit 流式预览体验已修复**:流式内容现在就是最终替换代码,不再在 inlay 中显示 `{"oldText":"..` 这类 JSON 片段。
3. **`Alt+Y/N/R` 快捷键冲突**:IntelliJ 默认 `Alt+Y` 在某些键位映射上有 IDE 占用。若用户反馈冲突,可改成 `Tab/Esc/Alt+R`。
4. ✅ **编译验证已补齐**:`./gradlew.bat` 仍有 wrapper jar manifest 问题,但已用系统 `gradle` 完成等价验证:`plugin: gradle compileKotlin`、`backend: gradle :codePilot-api:compileJava :codePilot-core:compileJava`,并完成 `plugin/webui: npm run build`。

### 4.2 待办清单(按优先级)

| 任务 | 备注 |
|---|---|
| **`wireup`** | ⚠️ 部分完成:P1 的 `Codebase/Rules/MCP/Shell` tabs 已挂载到 `App.tsx`;P0 的 `<ChangePanel />`、`<TabSettingsPanel />`、`<InlineEditTimeline />`、`<ChatViewV2 />` 仍待统一挂载。 |
| **P1-05** Codebase 索引面板 | ✅ 已完成:`IndexScheduler` 状态聚合 + `CodebasePanel` UI + `codebase.*` bridge;后端 `/v1/rag/*` 已核查,当前采用本地索引无需服务端扩展。 |
| **P1-06** Rules + Memories | ✅ 已完成:`RulesService` 支持 `.mdc/AGENTS.md/legacy rules`,`MemoryService` 持久化 `.codepilot/memories.json`,并注入 `projectRules`;prompts `rules.compile.txt/memory.distill.txt` 已补齐。 |
| **P1-07** MCP + Hooks | ✅ 已完成:`McpService` UI 化启停/授权,`HookEngine` 接入 `beforeSubmitPrompt/beforeShellExecution`,`McpHooksPanel` 已挂载。 |
| **P1-08** Shell Allowlist + 流式 | ✅ 已完成:`ShellPolicy` allow/deny/ask、确认弹窗、hook、stdout/stderr `shell.progress/tool.progress` 流式事件、`ShellPolicyPanel` 已挂载。 |
| **P2-09..P2-12** | ⏳ 未开始:UI/UX 类,客户端为主。`P2-11 ModelRouter Auto` 可能需服务端模型元数据扩展(模型→能力标签)。 |
| **P3-13** Background Agents | ⏳ 未开始:prompt `agent.background.txt` 已就绪,但服务端 `/v1/background-agents/*` 与 worktree 编排仍未实现。 |
| **P3-14** Share / Export | ⏳ 未开始:prompt `share.summary.txt` 已就绪,但服务端 `/v1/share/{create,get}` 与持久化仍未实现。 |
| **P3-15** Tab 多行预测 | ⏳ 未开始:prompt `agent.edit-prediction.txt` 已就绪,但客户端多行/跨位置 ghost 渲染仍未实现。 |

### 4.3 下一步建议

按 **`wireup` → P1-05 → P1-08 → P1-06/P1-07 并行 → P2 → P3** 顺序推进:

1. ✅ **已完成**:P1-05/P1-06/P1-07/P1-08 全部落地,并完成 `gradle compileKotlin`、`npm run build`、后端 Java 编译。
2. **下一步(<1 天)**:补完剩余 `wireup` — 挂载 P0 的 `<ChangePanel />`、`<TabSettingsPanel />`、`<InlineEditTimeline />`、`<ChatViewV2 />`,做一次端到端 smoke。
3. **之后(1 周+)**:进入 P2 系列,完成后做完整 E2E + 性能压测。
4. **最后(2 周+)**:P3 系列,当前 prompt 骨架已就绪,但服务端/客户端编排仍需单独实现。

---

## 5. 代码统计(粗略)

```
P0-01:  Kotlin   ~ 470 行 / TS  ~ 380 行 / 测试 110 行
P0-02:  Kotlin   ~ 180 行 / TS  ~ 520 行 / 测试  90 行
P0-03:  Kotlin   ~ 720 行 / TS  ~ 320 行 / 测试 180 行
P0-04:  Kotlin   ~ 520 行 / TS  ~ 200 行 / 测试  60 行
─────────────────────────────────────────────────────
合计:  Kotlin  ~1900 行 / TS ~1420 行 / 测试 ~440 行
       共计    ~3760 行新代码,16 个设计文档(共 ~7000 行)
```
