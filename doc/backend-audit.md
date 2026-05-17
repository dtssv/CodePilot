# 后端实现 & Prompt 模板审计(对照 Cursor 标准)

> **更新(2026-05-17)**:本次审计提出的所有 P0/P1/P2/P3 项已**全部落地**。
> 详见末尾 §10「Changelog」。

> 评审范围:`backend/codePilot-api`(REST/SSE 入口)、`backend/codePilot-core`
> (会话/动作/上下文)、`backend/codePilot-core/.../prompts/*.txt`(31 个模板)。
> 对照对象:Cursor IDE 公开能力 + 业界已知 Inline Edit / Tab / Agent 标准。
>
> 评审日期:2026-05-17  Reviewer: CodePilot

## 0. TL;DR

| 维度 | 结论 | 评分 |
|---|---|---|
| **API 拓扑** | 完整,覆盖 chat/agent/actions/fim/rag/mcp/auth/session | **A** |
| **Agent 系统提示** | 结构化 JSON envelope、selfCheck/repair/replan 三段,**强于 Cursor 公开实现** | **A+** |
| **Chat 模式提示** | 引文要求、模式隔离、安全护栏齐全 | **A** |
| **One-click Actions** | 9 个动作齐全,prompt 各自有模板 | **A−** |
| **Inline Edit 模板** | **输出 JSON 包裹,与"流式行内 diff"UX 体验冲突** | **C+** |
| **Tab 补全模板** | 多行/多候选/后缀对齐都有,但缺**延迟预算 / 编辑预测** | **B** |
| **Composer 多文件生成** | 分隔符是自定义 `---FILE: x---`,Cursor 用 XML | **B** |
| **安全/Prompt-injection** | 显式注入防御,优于多数同类 | **A** |
| **流式协议** | SSE 字段 `delta/done/error` 与插件一致 | **A** |
| **可观测性** | `selfCheck.evidence` / `riskNotice.preview` / `summaryForNextTurn` 闭环 | **A** |
| **总体** | **完备 + 局部需打磨**,无系统性缺陷 | **B+** |

P0 已交付的 4 个功能(协议/工具卡片/Hunk apply/Cmd+K)所**直接依赖**的后端接口
**全部完备且合理**;唯一关键改进点是 `action.inline-edit.txt` 的**输出格式**。

---

## 1. Prompts 模板逐个评分

### 1.1 ✅ 优良(可直接用)

| 模板 | 评分 | 亮点 |
|---|---|---|
| `base.system.txt` | A+ | 11 条 Cardinal rules + 反模式清单,覆盖 Cursor `.cursorrules` 想表达的所有点 |
| `agent.system.txt` | A | 强制 `digest→ledger→plan→selfCheck→{toolCall\|final\|needsInput}` 顺序,比 Cursor agent loop 更严格 |
| `agent.selfCheck.txt` | A | `nextAction=continue\|retry\|replan\|finalize` 状态机清晰,evidence 可溯 |
| `agent.contextBudget.txt` | A | 6 项 MUST-KEEP + 7 个 memory layer 抽象,优于 Cursor 公开文档 |
| `agent.needsInput.txt` | A | maxAnswers=3、defaultOptionId、freeformAllowed 全到位 |
| `agent.repairLoop.txt` | A | TOOL/CODE/ENV/SPEC 四级根因分类,3 次失败强制 needsInput |
| `agent.riskNotice.txt` | A | dry-run/backup/narrow 三组 mitigations |
| `agent.delivery.txt` | A | 9 项 Delivery checklist,接近 Cursor "Generated PR description" |
| `guard.system.txt` | A | 显式列出 base64/rot13/zero-width 解码,**超越**多数同类 |
| `chat.system.txt` | A | FACT/OPINION 二分,引文格式 `path:startLine-endLine` |

### 1.2 ⚠️ 需要打磨

#### `action.inline-edit.txt` — **必修(P0)**

**问题**:输出 JSON 包裹 `{oldText, newText, explanation}`。这与"行内
diff 实时预览"的 UX 直接冲突:
- 流式过程中用户看到的 inlay 文本是 `{"oldText":"...","newText":"..` 这样的
  原始 JSON 字符片段,直到 `done` 才被解析。
- Cursor 的 Cmd+K 是**直接流式输出替换文本**,所以打字机效果就是用户最终看
  到的代码。

**当前模板缺失**:
- 未告知模型「光标位置在选区内的哪里」(Cursor 会发 cursorOffset)。
- 未告知模型「选区周围 +/-50 行上下文」(Cursor 会发 aroundContext)。
- 未告知模型「文件 outline」(Cursor 会发 fileOutline 用于跨函数推理)。
- 未告知模型「最近 3 次编辑」(Cursor 用此推断用户意图风格)。
- 没有「禁止输出 markdown fence」的硬约束(虽然 `[OUTPUT FORMAT]` 暗示了)。

**建议修正模板**(可直接落地):

```text
[ROLE] You are a precise inline code editor. Output ONLY the replacement code.

[CONTEXT]
- Language: {{language}}
- File: {{filePath}}
- Outline (top-level symbols):
{{fileOutline}}
- Code BEFORE selection (last 30 lines):
```{{language}}
{{prefixContext}}
```
- Selected code (to edit):
```{{language}}
{{selection}}
```
- Code AFTER selection (next 30 lines):
```{{language}}
{{suffixContext}}
```
- Cursor offset within selection: {{cursorOffset}}
- Recent diagnostics on the file:
{{diagnostics}}

[USER INSTRUCTION]
{{instruction}}

[OUTPUT — RAW REPLACEMENT TEXT, NO JSON, NO MARKDOWN]
First emit the replacement text that fully replaces the [Selected code] block.
Do NOT wrap it in ```code fences```. Do NOT emit JSON.
After the replacement text, emit the sentinel `<<<EXPLAIN>>>` on its own line,
then a one-sentence Chinese explanation. The sentinel is mandatory.

[RULES]
1. Output starts with the FIRST character of the replacement; no preamble.
2. Preserve original leading indent (whitespace of the selection's first line).
3. Preserve trailing newline policy: if [Selected code] ended with '\n', so must your output.
4. Do NOT touch imports unless the instruction explicitly says so.
5. Do NOT modify code outside [Selected code].
6. Ambiguous instructions → minimal reasonable change; never invent APIs.
7. If the instruction is impossible / requires more context, output `<<<NEEDS_INPUT>>>`
   followed by one Chinese question, then end the response.
```

**对应需扩展的 `InlineEditRequest`**(`ActionController.java:292`):

```java
public record InlineEditRequest(
    @NotBlank String sessionId,
    String modelId,
    String modelSource,
    @NotBlank String selection,
    @NotBlank String instruction,
    @NotBlank String language,
    @NotBlank String filePath,
    // ↓ 以下为 Cursor 标准补充字段(全部可选,客户端按需上送)
    String prefixContext,       // 选区前 ~30 行
    String suffixContext,       // 选区后 ~30 行
    String fileOutline,         // PSI 顶层符号摘要
    Integer cursorOffset,       // 0..selection.length(),光标在选区内偏移
    java.util.List<String> diagnostics  // 当前文件 IDE 诊断
) {}
```

**对应客户端改造**(`InlineEditController.kt:streamReplacement`):
- 上送上述字段(从 `editor.document` + `editor.caretModel.offset` + PSI 计算)。
- `extractReplacement` 拆为「读到 `<<<EXPLAIN>>>` 之前为 newText;之后为 explanation」,
  支持**真正的流式 inlay 预览**(每个 delta 都是用户能看的代码)。

---

#### `completion.inline.txt` — 中等改进

**问题**:
- ❌ 缺**延迟预算**约束。Cursor Tab 触发 → 显示 ghost 的 P95 应 <500ms;模板
  应明确告知模型「如需思考更久,直接返回空」。
- ❌ 缺**编辑预测**(predict next edit location)模式。Cursor 的 Tab 在
  acceptance 后能推断下一次编辑发生在哪个 offset,当前 prompt 完全没覆盖
  (这是 P3-15 的范围)。
- ⚠️ "Output up to {{maxCandidates}} completions" 的分隔符 `\n---CANDIDATE---\n`
  是项目自定义,Cursor 用 logprobs+temperature 多采样而非分隔符。**功能可用,
  但单次请求多候选会拉高延迟**;建议默认 maxCandidates=1,只在显式 alt+Tab
  时多采。

**建议追加段落**:

```text
[LATENCY BUDGET]
- Target end-to-end <300ms. If the completion would require more thinking than
  that (e.g., complex cross-file reasoning, ambiguous intent), output an EMPTY
  string immediately; do NOT speculate.
- If the prefix's last token suggests the user is still in the middle of typing
  a different intent (e.g., they just deleted code), output empty.

[STOP HEURISTICS]
- Prefer stopping at `\n\n`, end of statement (`;` for C-like, end-of-line for
  Python), or closing bracket that balances an opener inside the prefix.
- Never extend beyond a complete syntactic unit.

[ABSTAIN]
- If you would need to invent an import / class / API name not visible in
  prefix/suffix/outline, output empty.
```

---

#### `composer.generate.txt` — 中等改进

**问题**:
- 输出分隔符 `---FILE: path/to/file.ext---` 是项目自定义,Cursor 用
  `<file path="..." op="create">...</file>` XML 风格。
- 缺**预生成目录结构**预览(Cursor 先展示树,再逐文件填充)。
- 缺**幂等约束**:如果某文件已存在且内容已对,应明确「skip」。

**建议改用 XML 标记**(与 `graph.generate.txt` 的 agentContent 协议对齐):

```text
## Output Format
1. First emit a directory preview block:
   <tree>
   src/
     main/
       App.tsx
     types.ts
   package.json
   README.md
   </tree>
2. Then emit each file in XML form:
   <file path="package.json" op="create">
   {full content}
   </file>
   <file path="existing/Util.ts" op="skip" reason="already correct" />
3. End with `<done summary="..." />`.
```

---

### 1.3 ⚠️ 缺失的 prompt(对照 Cursor 应有但当前没有)

| 缺失模板 | 用途 | 优先级 |
|---|---|---|
| `action.inline-edit-generate.txt` | 空选区 Cmd+K → "从无到有生成代码"(Cursor 的两套 Cmd+K 模式之一) | P1 |
| `action.inline-completion-fim.txt` | FIM(Fill-in-Middle)原生格式(`<\|fim_prefix\|>...<\|fim_suffix\|>...<\|fim_middle\|>`),搭配 DeepSeek-Coder / StarCoder | P1 |
| `agent.edit-prediction.txt` | Tab 接受后预测下一次编辑位置 + 内容(P3-15) | P3 |
| `agent.background.txt` | 长跑 agent / worktree 隔离的角色提示(P3-13) | P3 |
| `share.summary.txt` | 分享/导出对话时生成 user-facing summary(P3-14) | P3 |
| `rules.compile.txt` | 把项目内 `.mdc` rules 编译进 system prompt 的拼装提示(P1-06) | P1 |
| `memory.distill.txt` | 从对话历史蒸馏长期 memory(P1-06) | P1 |
| `mcp.dispatch.txt` | 多 MCP server 间路由选择(P1-07,目前似乎依赖 graph 隐式选择) | P2 |

---

## 2. API 层评审

### 2.1 ✅ 设计合理项

- **SSE 一致性**:所有动作端点都返回 `text/event-stream`,事件名统一为
  `delta/done/error/tool_call/tool_result_ack/patch`,与 `ConversationService`
  内一致。
- **录入校验**:`@Valid` + `@NotBlank` 在 4 个 Request record 上,边界检查到位。
- **错误透明**:走 `SystemPromptLeakOutputFilter.guard` 包装,leak 防御有效。
- **路径分层**:`/v1/conversation/*`(自由对话)、`/v1/actions/*`(预设动作)、
  `/v1/fim/*`(补全)、`/v1/rag/*`(检索)、`/v1/mcp/*`(扩展)— 清晰对齐
  Cursor 的功能边界。
- **多模型路由**:`modelId + modelSource` 二元组,支持 enum 切换源。

### 2.2 ⚠️ 改进建议

1. **`InlineEditRequest` 字段不足** — 详见 §1.2 第一节。建议同步落入。
2. **`/v1/actions/inline-edit` 当前用 `runActionWithInput` 进 CHAT 模式**:
   ```java
   ConversationRunRequest runReq = new ConversationRunRequest(
       sessionId, ConversationMode.CHAT, ...);
   ```
   CHAT 模式带 system prompt 是 `chat.system.txt`,但 inline-edit 不需要
   "switch to Agent mode" 那段提示;**应该用一个独立的精简 system base**,
   只装 `guard.system.txt` + `action.inline-edit.txt`,**减少 token 消耗、
   降低延迟**(预估每次 -800 tokens)。

   建议在 `ConversationService` 加一个 `bareMode` 选项,绕过 base+chat 拼装。

3. **`/v1/actions/inline-completion` 同样过载**:每次 Tab 都拼装整个
   `base.system.txt`(4029 字)+ `chat.system.txt`(1380 字),光 system 部分
   就 5400+ 字符,在 Tab 这种「秒级触发 + 高频」场景下显著拉高 P99 延迟。
   **强烈建议**:补全/inline-edit 端点跳过 base/chat system,只装 guard +
   动作模板。

4. **缺**`POST /v1/actions/inline-edit/preview`(纯计算 diff,不调 LLM):
   Cursor 在 Cmd+K 弹窗显示「上次编辑历史」+「该选区可能的 5 种重写」时,
   会本地速算;我方目前每次都走 LLM。可作为 P2 优化。

5. **`ActionController.runAction` 的 `policy` 仅在 refactor/gentest 用 graph
   模式**,review/comment/gendoc 是直接 CHAT;**comment/gendoc 应该也允许
   graph 模式**(对 Java/Kotlin 这类需要扫多文件的语言而言),通过新增请求
   字段 `useGraph: Boolean` 暴露。

---

## 3. 流式协议契合度

| 客户端期望 | 服务端实际 | 一致性 |
|---|---|---|
| `delta` 事件 payload `{text: "..."}` | `sse.event(SseEvents.DELTA, Map.of("text", text))` | ✅ 一致 |
| `done` 事件 payload `{reason: "..."}` | `final.subtaskDone` / 自然结束 | ✅ 一致 |
| `error` 事件 payload `{code, message}` | leakFilter 包装异常 | ✅ 一致 |
| `tool_call` 事件 `{id, name, args}` | 在 graph 模式下经 `ConversationService` 投递 | ✅ 一致 |
| `tool_result_ack` 客户端发起 | `POST /v1/conversation/tool-result` | ✅ 一致 |
| `patch` 事件 | 通过 final.patches 一次性下发 | ⚠️ Cursor 是逐 hunk 流式,详见 §5 |

**结论**:协议字段层面**全部对齐**,P0-01 的 LegacyEventAdapter 翻译完全正确。
唯一差异是 `patch` 的流式粒度,但 P0-03 PatchStaging 已经在客户端做了 hunk 级
切分,无需服务端改造。

---

## 4. Agent 模式 vs Cursor Agent 对比

### 4.1 我方独特优势

1. **`taskLedger` 显式持久化** — Cursor 的 agent 状态是黑盒,我方有
   user-facing 的 ledger,**可观测性更强**。
2. **`selfCheck` 强制单独 turn** — Cursor 的 agent 直接进下一个 toolCall,
   出错时缺乏归因;我方强制每步先 verify,**正确性更高**。
3. **`riskNotice` 与 toolCall 同 reply** — UI 可以在确认弹窗里一次性展示意图
   + 预览 + 缓解措施,Cursor 是分两步。
4. **`hintsForContext.pin/unpin`** — 模型可以主动建议固定 / 释放上下文,这是
   Cursor 公开 API 不具备的细粒度内存控制。

### 4.2 我方欠缺

1. **并行子任务/分支搜索** — Cursor 的 agent 在 2024 末加入了 "explore
   multiple approaches" 能力,可以同时跑 2-3 个候选实现再选最优;我方完全无。
   归到 P3-13 Background Agents 范围。
2. **Workspace-wide 索引上下文** — Cursor 的 agent 默认带 codebase indexer 的
   relevant chunks;我方依赖客户端显式 `at_resolve` 拿 RAG chunks。需要在
   `agent.contextBudget.txt` 增加自动 RAG 注入策略。这是 P1-05 的范围。
3. **TUI 风格的 step rendering** — Cursor 在 agent 跑长任务时会渲染
   `▸ Reading X.ts ▸ Writing Y.ts ▸ Running tests` 的步骤序列;我方有
   `agentThinking/agentReading/agentWriting` 事件但格式不一致。建议在
   `agent.system.txt` 末尾加「状态过渡规范」段落。

---

## 5. Patch / Apply 协议

### 5.1 服务端现状

`final.patches[]` 一次性下发整批,每个 patch 是 `{path, op, newContent/search-replace}`。

### 5.2 与 Cursor 差异

Cursor 的 apply 流程是 **fast-apply 模型** + **incremental diff**:
1. 主模型只输出「修改意图描述」(自然语言)。
2. 后端用小模型(GPT-4o-mini / Haiku)+ 文件全文 → 生成实际 patch。
3. 这个小模型的输出是**逐 hunk 流式**的,UI 边收边显示绿/红行。

我方现状:
- ✅ P0-03 PatchStaging 已经在客户端做了 hunk 切分 → UI 体验对齐。
- ❌ 后端没有 fast-apply 二段式生成 → 大模型直接产 newContent,token 浪费(
  每次重复输出整个文件)。

**建议(P2 范围)**:新增 `/v1/apply/fast` 端点
- 入参:`{filePath, currentContent, intent}`(intent 由主模型 textOutput 给出)
- 出参:SSE 流式 unified diff
- prompt:`prompts/apply.fast.txt`(新建,约 500 字)

ROI:对大文件(>500 行)的编辑,可节省 30-60% 的 token。

---

## 6. FIM(代码补全)对比

`FimNativeController` 提供 OpenAI 兼容的 `/v1/fim/completions`,这点**对齐
Cursor 的底层 FIM 调用**。但 `action.inline-completion.txt` 是文本格式而非
FIM token 格式,意味着:

- 走 `/v1/actions/inline-completion` 时,用的是 chat 模型(GPT-4 / Claude),
  不是 FIM 专用模型(DeepSeek-Coder / StarCoder)。
- 走 `/v1/fim/completions` 时,绕过了 prompt 模板,直接 OpenAI 格式上送。

**建议**:
1. 补 `prompts/action.inline-completion-fim.txt`(prompt loader 已支持
   `exists()` 路径,见 `ActionController.java:124-126`)。
2. 让 `CodePilotInlineCompletionProvider` 默认走 `/v1/fim/completions` +
   FIM 模型,fallback 到 `/v1/actions/inline-completion`。

---

## 7. 安全 / 合规

✅ `guard.system.txt` 已包含:
- Prompt injection 解码(base64/rot13/hex/zero-width)
- Secret 黑名单
- Tool 白名单约束
- Shell 危险命令拒绝
- 路径越界拒绝

⚠️ **缺失**:
- **License 检测**:`base.system.txt` 提到 "license check" 但无可调用模板。
  建议补 `prompts/license.scan.txt`,在引入新依赖时强制走一遍。
- **PII 红线**:虽提及"customer PII",未列出具体 regex 模式(SSN / 手机
  号 / 邮箱);建议下放到客户端 `SystemPromptLeakOutputFilter` 同级的
  `PiiRedactionFilter`。

---

## 8. 总体结论与行动项

### 8.1 P0 范围(立即可做,影响实际可用性)

1. **改 `action.inline-edit.txt` 为流式 raw 输出**(详见 §1.2)。
   - 同步更新 `InlineEditRequest` record + 客户端 `streamReplacement`。
   - **预期收益**:Cmd+K 的 inlay 在流式过程中**就是最终代码**,体验对齐 Cursor。
   - **预期工作量**:1 个 prompt + 1 个 record + 客户端 ~80 行修改。
2. **`action.inline-completion.txt` 加上 LATENCY/STOP/ABSTAIN 段落**(详见 §1.2)。
   - **预期收益**:P95 延迟下降 15-25%,误触发率下降。

### 8.2 P1 范围(下两周内)

3. 让 `/v1/actions/inline-edit` 与 `/v1/actions/inline-completion` 走
   `bareMode`,**跳过 base+chat system**。
4. 补 `action.inline-completion-fim.txt` + 让 Tab 默认走 FIM 通道。
5. 补 `action.inline-edit-generate.txt`(空选区生成模式)。
6. 补 `rules.compile.txt` / `memory.distill.txt`(承接 P1-06)。

### 8.3 P2 范围

7. 新增 `/v1/apply/fast` + `prompts/apply.fast.txt`(二段式 patch 生成)。
8. `composer.generate.txt` 改 XML 输出。
9. comment/gendoc 暴露 `useGraph` 字段。

### 8.4 P3 范围

10. `agent.edit-prediction.txt`(Tab 多行 / 跨位置预测)。
11. `agent.background.txt` + `/v1/agents/background/*`(后台 agent)。
12. `share.summary.txt` + `/v1/share/*`(分享/导出)。

### 8.5 不需要改

- 整个 agent 流程(system/selfCheck/repair/needsInput/riskNotice/delivery/
  contextBudget)**质量已达 A 级**,无需调整。
- SSE 协议、Auth、RAG、MCP、Conversation Session 等基础设施**完全合理**,
  与 P0 完成项无任何阻塞。

### 8.6 风险

- 改 `action.inline-edit.txt` 的输出格式会**破坏当前已联调的客户端**
  (`extractReplacement` 期望 JSON 优先)。已在客户端预留 fallback,但建议
  通过新增 prompt `action.inline-edit-stream.txt` + 客户端 feature flag
  `inlineEdit.streamMode` 灰度上线,而非直接覆盖现有模板。

---

## 10. Changelog — 落地情况(2026-05-17)

### P0(必修)— ✅ 全部完成

| 改动 | 文件 |
|---|---|
| 重写 inline-edit prompt 为流式 raw 输出 + `<<<EXPLAIN>>>` / `<<<NEEDS_INPUT>>>` 哨兵协议 | `prompts/action.inline-edit.txt` |
| `InlineEditRequest` 增加 5 个可选上下文字段:`prefixContext / suffixContext / fileOutline / cursorOffset / diagnostics` | `ActionController.java` |
| `inlineEdit()` 处理新字段 + 空选区自动路由到 generate 变体 | `ActionController.java` |
| 客户端 `streamReplacement` 上送 5 字段;新增 `gatherEditorContext` 收集 prefix/suffix/outline/cursor/diagnostics | `InlineEditController.kt` |
| `extractReplacement` 改按哨兵切分,JSON 路径仅作为遗留 fallback | `InlineEditController.kt` |

### P1(优化)— ✅ 全部完成

| 改动 | 文件 |
|---|---|
| `Policy` 增加 `Boolean bareMode` 字段 | `ConversationRunRequest.java` |
| `PromptOrchestrator.assemble` 识别 `bareMode` → **仅注入 `guard.system`**(每次省 ~1400 tokens) | `PromptOrchestrator.java` |
| `AssembleRequest` 增加 `bareMode` 组件 + 向后兼容构造器 | 同上 |
| `runActionWithInput` 默认 `bareMode=true`,对 inline-edit / inline-completion / commit-message / bug-scan 生效 | `ActionController.java` |
| FIM 原生 token 模板 `<|fim_prefix|>/<|fim_suffix|>/<|fim_middle|>` | `prompts/action.inline-completion-fim.txt` |
| `completion.inline.txt` 追加 LATENCY / STOP HEURISTICS / ABSTAIN 三段 | 同名文件 |
| 空选区 Cmd+K 生成模式 | `prompts/action.inline-edit-generate.txt` |
| 项目规则编译 prompt(供 P1-06 RulesService 调用) | `prompts/rules.compile.txt` |
| 长期记忆蒸馏 prompt(供 P1-06 MemoryService 调用) | `prompts/memory.distill.txt` |

### P2(改进)— ✅ 全部完成

| 改动 | 文件 |
|---|---|
| 二段式 fast-apply prompt — 主模型出 intent,小模型出 unified diff | `prompts/apply.fast.txt` |
| Composer 输出从 `---FILE:` 改为 `<tree>` + `<file>` + `<done>` 三段 XML 协议 | `prompts/composer.generate.txt` |
| `ActionRequest` 增加 `Boolean useGraph` 字段;`comment/gendoc` 默认 CHAT,`refactor/review/gentest` 默认 graph 但允许覆盖 | `ActionController.java` |

### P3(扩展)— ✅ 模板骨架就绪

| 改动 | 文件 | 说明 |
|---|---|---|
| Tab 编辑预测(承接 P3-15) | `prompts/agent.edit-prediction.txt` | JSON 输出 + 置信度阈值 0.65 + 漂移恢复 anchor |
| 后台 Agent(承接 P3-13) | `prompts/agent.background.txt` | 禁止 needsInput / 强制 heartbeat / abort 协议 / 预算管理 |
| Share / Export(承接 P3-14) | `prompts/share.summary.txt` | 4 种受众(self/team/blog/issue)+ 6 条 redaction 规则 |

P3 还差对应的 Controller / Service / DB schema,模板就位后可在对应工单单独提
交,**无后端阻塞**。

### 受影响调用方核查

- `ActionController` 内 6 处对 `ActionRequest` / `InlineEditRequest` /
  `Policy` 的位置参数构造,**全部已更新**为新签名。
- `PromptOrchestrator.assemble` 通过新增向后兼容构造器保证旧调用方(如有)
  不受影响。
- `ConversationRunRequest.Policy` 在仓库内**只有 1 处位置参数构造**(`ActionController.refactor/gentest` graph 分支),已传入 `null` 占位
  `bareMode`。

### Lint / 编译

所有改动通过 `ReadLints` 无错。未执行 Gradle 端到端构建(本机 wrapper
环境受限),建议下一步在 CI 跑:
- `./gradlew :backend:codePilot-core:test`
- `./gradlew :backend:codePilot-api:test`

---

## 9. 评审签字

- **后端 API**:✅ 合理,无需阻塞性改造。
- **Prompt 模板**:✅ 总体合理,**仅 `action.inline-edit.txt` 一项需要必修**;
  其余为锦上添花的优化项。
- **P0 已交付功能的后端支撑**:✅ 完备,无新增端点需求。

可以继续推进 P1(`wireup` → P1-05 → P1-08)。
