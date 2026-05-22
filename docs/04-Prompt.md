# 04 — Prompt 体系

> 更新日期：2026-05-22
> 本文档基于实际代码实现编写，已完成项标注 ✅，待办项见 [06-优化及推进方案](./06-优化及推进方案.md)

---

## 1. 总体架构

CodePilot 的 Prompt 体系由三部分组成：

1. **骨架 workflow**（`PromptRegistry` 20个必需段）：每轮请求都会拼装进 system，定义身份、产出契约、交互协议、安全红线
2. **Skill 包**：按需加载的领域指令，由 `SkillRouter` 基于上下文动态激活并合并到 system
3. **Action 专用模板**：9个动作（refactor/review/comment/gentest/gendoc/inline-edit/commit-message等）各有独立模板

### 1.1 语言策略 ✅

- 所有 prompt 内容（代码块内的指令文本）一律用英文
- 面向用户的字段在产出时使用 `{{userLocale}}`（默认 zh-CN）：
  - `final.answer`、Review 报告正文、Comment/Doc 生成文本
  - `needsInput.title/reason/questions[*].prompt` 等
  - `taskLedger.goal/subtasks[*].title` 等
  - `plan.steps[*].title`（用户可见时）

---

## 2. PromptOrchestrator 拼装流程 ✅

拼装顺序（由上到下追加为一条 system 消息）：

```
1. base.system           — 通用人设 + Cardinal rules + 反模式
2. agent.system          — Agent输出契约（Plan-First多轮增量推进）
3. projectRules          — .codepilot/rules/ 项目规则
4. tools.schema          — 工具JSON Schema
5. agent.compact         — 压缩指令（条件命中时追加）
6. agent.replan          — 重规划指令（条件命中时追加）
7. agent.userEdits       — 用户编辑反馈
8. guard.system          — Prompt注入防御
```

Skill 的 `systemPrompt` 由 `SkillRouter` 在 `PromptOrchestrator` 组装前追加。

---

## 3. PromptRegistry 必需段 ✅

| 段名 | 用途 | 评分 | 状态 |
|---|---|---|---|
| `base.system` | 通用人设与11条Cardinal rules + 反模式清单 | A+ | ✅ |
| `agent.system` | Plan-First多轮增量推进契约（digest→ledger→plan→selfCheck→toolCall/final/needsInput） | A | ✅ |
| `agent.tools` | 工具JSON Schema注入 | A | ✅ |
| `agent.compact` | 上下文压缩指令（digest schema + compaction rules） | A | ✅ |
| `agent.replan` | 重规划指令（输出完整plan + 不同分解） | A | ✅ |
| `agent.userEdits` | 用户编辑反馈（反映到planDelta） | A | ✅ |
| `agent.selfCheck` | 工具结果自检（nextAction状态机：continue/retry/replan/finalize） | A | ✅ |
| `agent.contextBudget` | 上下文预算（6项MUST-KEEP + 7个memory layer） | A | ✅ |
| `agent.needsInput` | 追问指令（maxAnswers=3/defaultOptionId/freeformAllowed） | A | ✅ |
| `agent.riskNotice` | 风险预告（dry-run/backup/narrow三组mitigations） | A | ✅ |
| `agent.repairLoop` | 修复循环（TOOL/CODE/ENV/SPEC四级根因 + 3次失败强制needsInput） | A | ✅ |
| `agent.resume` | 断点续跑指令 | A | ✅ |
| `agent.delivery` | 交付检查（9项Delivery checklist） | A | ✅ |
| `guard.system` | Prompt注入防御（base64/rot13/zero-width解码防护，**超越**多数同类） | A | ✅ |
| `chat.system` | Chat模式system（FACT/OPINION二分 + 引文格式path:startLine-endLine） | A | ✅ |
| `graph.planning` | PlanningAction专用模板（双层Plan + skipPlan） | A | ✅ |
| `graph.generate` | GenerateAction专用模板（patches/textOutput/agentContent分离） | A | ✅ |
| `graph.conversational` | 无工具纯对话模板（intake判定无需工具时使用） | A | ✅ |
| `graph.intake` | Intake意图分类模板（needsTools/needsPlanning/tools[]） | A | ✅ |
| `graph.approach-exhausted` | 策略耗尽处理模板 | A | ✅ |

---

## 4. Skill 体系 ✅

### 4.1 Skill 包 Schema

```yaml
id: skill.lang.java              # 唯一标识
version: 1.3.0                   # 语义化版本
title: "Java language profile"
source: system|user              # 运行时严格区分
scope: system|project|global     # system Skill恒为system；user为project/global
triggers:                        # 任意命中即激活
  any:
    - language: [java]
    - fileGlob: ["**/*.java"]
  all:
    - mode: agent
permissions:
  tools: [fs.read, fs.replace, shell.exec]
  risk: [low, medium, high]
priority: 50                     # 0..100
merge: append                    # append|override|wrap
systemPrompt: |                  # 仅在命中时追加到system；必须英文
  ...
```

### 4.2 来源与信任级别 ✅

| Source | 物理位置 | 信任级别 | 是否随后端发版 | 是否可被客户端获取正文 |
|---|---|---|---|---|
| **system**（内置） | 后端jar内/配置中心 | 高 | 是 | **否**（仅暴露安全摘要） |
| **user**（用户自有） | 仅用户本地目录 | 低 | 否 | 是（本地拥有；上行后用完即丢） |

### 4.3 Merge 语义 ✅

- **append**（默认）：在system末尾追加
- **override**：覆盖同id+major.version的Skill（仅system→system允许）
- **wrap**：在另一个Skill前/后插入约束（user可对system使用wrap，但仅能收紧）

### 4.4 默认激活集合 ✅

| Skill | 触发条件 |
|---|---|
| `skill.patching` | agent模式，总是激活(priority=70) |
| `skill.delivery` | approachingDelivery=true |
| `skill.repair` | priorTurnFailed=true |
| `skill.resume` | intent in [continue, answer] |
| `skill.style-profile` | 每轮都激活（低开销） |
| `skill.lang.*` | 按language激活，至多1主语言+1辅助 |
| `skill.scenario.*` | 按action关键词激活，至多2个 |
| `skill.action.refactor/review/comment/gentest/gendoc` | 按action命中时激活 |

---

## 5. Action 及专项 Prompt 模板 ✅

### 5.1 Action 模板（9个，由 ActionPromptLoader 加载）

| Action | 模板 | 输出格式 |
|---|---|---|
| Refactor | `action.refactor.txt` | Patch JSON + selfCheck + followUps |
| Review | `action.review.txt` | Markdown报告（1-5评分 + P0/P1/P2分级） |
| Comment | `action.comment.txt` | Patch JSON（仅添加注释） |
| GenTest | `action.gentest.txt` | Patch JSON + runHints + selfCheck |
| GenDoc | `action.gendoc.txt` | Markdown文档 |
| Inline Edit | `action.inline-edit.txt` | 原始替换文本 + `<<<EXPLAIN>>>` 分隔说明 |
| Inline Edit Generate | `action.inline-edit-generate.txt` | 内联编辑生成 |
| Inline Completion FIM | `action.inline-completion-fim.txt` | FIM补全 |
| Commit Message | `action.commit-message.txt` | Conventional Commits格式纯文本 |
| Bug Scan | `action.bug-scan.txt` | Bug列表 + 修复建议 |

### 5.2 专项模板（按需加载，共13个）

| 模板 | 用途 |
|---|---|
| `agent.background.txt` | 后台Agent模板 |
| `agent.edit-prediction.txt` | 编辑预测模板 |
| `apply.fast.txt` | 快速Apply模板 |
| `completion.inline.txt` | 内联补全模板 |
| `composer.generate.txt` | Composer生成模板 |
| `memory.distill.txt` | 记忆蒸馏模板 |
| `rules.compile.txt` | 规则编译模板 |
| `share.summary.txt` | 分享摘要模板 |
| `shell.generate.txt` | Shell命令生成模板 |
| `skill.delivery.txt` | Skill交付模板 |
| `skill.repair.txt` | Skill修复模板 |
| `skill.resume.txt` | Skill续跑模板 |
| `tab.infill.txt` | Tab填充模板 |

---

## 6. 核心产出契约

### 6.1 Agent模式 Envelope ✅

```json
{
  "digest": null,
  "taskLedger": null,
  "taskLedgerDelta": null,
  "plan": null,
  "planDelta": null,
  "thought": "<=200 tokens internal reasoning",
  "selfCheck": null,
  "toolCall": null,
  "needsInput": null,
  "final": null,
  "riskNotice": null
}
```

每轮输出必须包含以上字段，且只允许一个主要动作（toolCall/final/needsInput互斥）。

### 6.2 Plan Schema ✅

```json
{
  "goal": "...",
  "assumptions": ["..."],
  "constraints": ["..."],
  "successDefinition": ["..."],
  "steps": [
    {
      "id": "s1",
      "title": "verb-object short title",
      "intent": "why this step",
      "tools": ["fs.read", "rag.search"],
      "expectedOutcome": "...",
      "acceptance": ["..."],
      "riskLevel": "low|medium|high",
      "reversible": true,
      "dependsOn": [],
      "status": "pending|running|success|failed|skipped|cancelled"
    }
  ],
  "terminationCriteria": ["..."],
  "outOfScope": ["..."]
}
```

### 6.3 SelfCheck Schema ✅

```json
{
  "toolCallId": "tc-<n>",
  "stepId": "s<n>",
  "ok": true,
  "matchedExpectation": true,
  "checks": [
    {"name": "...", "passed": true, "detail": "..."}
  ],
  "evidence": [
    {"kind": "file", "path": "...", "range": "..."}
  ],
  "sideEffects": [
    {"op": "replace", "path": "...", "linesChanged": 17}
  ],
  "risk": "low|medium|high",
  "nextAction": "continue|retry|replan|finalize",
  "reason": "..."
}
```

### 6.4 NeedsInput Schema ✅

```json
{
  "title": "...",
  "reason": "...",
  "questions": [
    {
      "id": "q1",
      "prompt": "...",
      "why": "...",
      "options": [
        {"id": "o1", "label": "...", "pros": "...", "cons": "..."}
      ],
      "defaultOptionId": "o1",
      "freeformAllowed": true
    }
  ]
}
```

### 6.5 RiskNotice Schema ✅

```json
{
  "level": "medium",
  "headline": "...",
  "preview": "...",
  "filesPaths": ["..."],
  "mitigations": [
    {"label": "Dry-run", "description": "..."},
    {"label": "Backup", "description": "..."},
    {"label": "Narrow scope", "description": "..."}
  ]
}
```

---

## 7. 安全约束 ✅

1. **系统提示词机密性**：PromptRegistry永不返回prompt body给客户端
2. **Prompt注入防御**：guard.system列出base64/rot13/zero-width等解码方式防护
3. **输出泄露过滤**：SystemPromptLeakOutputFilter对delta/patches做关键词匹配+Rabin-Karp 30-gram相似度检测
4. **Skill隔离**：user Skill的systemPrompt被包裹在`[USER_SKILL_BEGIN]...[USER_SKILL_END]`标签中
5. **不可干扰契约**：user Skill不允许重定义envelope字段、selfCheck/needsInput协议、guard安全规则

---

## 8. 模板质量评估

| 类别 | 评分 | 说明 |
|---|---|---|
| Agent系统提示 | A+ | 结构化JSON envelope、selfCheck/repair/replan三段，强于Cursor公开实现 |
| Chat模式提示 | A | FACT/OPINION二分，引文格式完整 |
| One-click Actions | A− | 9个动作齐全，各有模板 |
| 安全/Prompt-injection | A | 显式注入防御，超越多数同类 |
| 流式协议 | A | SSE字段与插件一致 |
| 可观测性 | A | selfCheck.evidence / riskNotice.preview / summaryForNextTurn闭环 |
| **总体** | **A** | 完备+局部打磨，无系统性缺陷 |