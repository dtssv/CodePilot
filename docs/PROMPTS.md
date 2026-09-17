# CodePilot 提示词（Prompts）一览

> 所有面向 LLM 的提示词都集中在 `packages/core`（core 是唯一与模型交互的组件；TUI/IDE 插件不含任何 prompt）。

## 0. 设计目标与分层

CodePilot 的 prompt 设计参考 claude-code / codex / Cursor 的成熟实践，遵循以下原则：

- **分层 + 缓存友好**：把系统提示拆成"静态前缀"（角色、规则、风格，跨轮次稳定）和"动态后缀"（环境、git、记忆、plan，每轮可变）。静态前缀不依赖时间或 git 状态，便于 provider 的 prompt cache 命中（Anthropic `cache_control` / OpenAI 自动前缀缓存）。
- **结构清晰**：静态前缀采用 markdown 大节 + XML-ish 标签块；动态后缀用结构化的 `<environment> <git> <memory> <plan> <tools>` 块。
- **可测试**：环境信息抽取通过 `EnvironmentProvider` 接口注入；测试用 fake provider 即可，不再依赖真实 git / 主机信息。
- **可调优**：每个 prompt 都有明确边界（静态 vs 动态、综述 vs 工具描述），需要调行为时改单个文件即可。

## 1. 系统提示 — `packages/core/src/systemPrompt.ts`

### 1.1 静态前缀（`buildStaticPrefix`）

`buildSystemPrompt` 构造静态前缀的章节如下（设计目标 3000-6000 token）：

| §  | 章节 | 作用 |
|----|------|------|
| 0  | `CodePilot — Software Engineering Agent` | 角色与运行环境总述 |
| 1  | Identity and Environment | 与运行环境 / 模式切换 / 事件流的约定 |
| 2  | Tool-Use Policy | 先读后写、search/replace 优先、并行独立调用、委派子代理、artifact 分页 |
| 3  | Code Conventions | 沿用项目风格、不引未要求依赖、不写无意义注释 |
| 4  | Planning and Task State | 用 `plan_update` 拆任务、状态流转规范 |
| 5  | Testing and Verification | 改完必跑相关测试/构建、迭代修复、报告结果 |
| 6  | Git Etiquette | 不主动 commit/push、不动 .git、不 force-push |
| 7  | Memory | 沉淀项目知识到 `CODEPILOT.md` / `MEMORY.md` |
| 8  | Token Efficiency | 不重复读、用 grep/glob 精确定位、总结而非粘贴 |
| 9  | Communication Style | 简洁、直接、技术化、不奉承、用户语言 |
| 10 | Safety and Security | 不输出密钥、不执行可疑命令、报告安全问题 |
| 11 | Collaboration Modes | 当前模式（chat/plan/agent）的具体行为约束 |
| 12 | Tool Reference | 当前会话可见工具名列表（`ctx.toolNames`） |
| 13 | Project-Specific Notes | `systemPromptExtra` 注入的额外说明（可选） |

`modeGuidance(mode)` 在 §11 中按模式生成对应段落（chat/plan/agent），是模型在当前回合必须遵守的硬约束。模式切换时（`Session.setAgentMode`）整段 system prompt 会重建；其他 § 在同会话内通常保持稳定 → cache 命中。

### 1.2 动态后缀（`buildDynamicSuffix`）

每轮重建，结构如下：

```
<environment>
provider: anthropic
model: claude-sonnet-4-5
mode: agent
os: darwin 23.4.0 arm64
hostname: ...
user: ...
shell: /bin/zsh
node: v20.10.0
cwd: /Users/.../CodePilot
now: 2025-01-01T10:00:00.000Z
timezone: Asia/Shanghai
</environment>

<git>
in_repo: true
root: /Users/.../CodePilot
branch: main
dirty: false
last_commit: 1a2b3c4
last_commit_subject: feat: improve prompts
status:
  ## main
</git>

<memory>
### Project (CODEPILOT.md)
<...>
### User (~/.codepilot/MEMORY.md)
<...>
</memory>

<plan>
[ ] step_1 — Read current prompt
[~] step_2 — Rewrite prefix
[x] step_3 — Run tests
</plan>

<tools>
bash
edit_file
read_file
...
</tools>
```

`EnvironmentProvider` 接口（见 `src/env.ts`）收集主机/Node/cwd/时间/`git rev-parse`/`git status`/`git log` 等信息。默认实现 `defaultEnvironmentProvider` 直接走 `child_process.execFile`，所有 git 调用都有 2s 超时并捕获错误，cwd 不在 repo 内时 `git` 块退化为 "not a git working tree"。

测试中可注入自定义 provider：

```ts
const fakeEnv: EnvironmentProvider = {
  async snapshot() {
    return {
      os: "linux 6.0.0 x64",
      hostname: "ci-runner",
      user: "ci",
      shell: "/bin/bash",
      node: "v20.10.0",
      cwd: "/work",
      now: "2025-01-01T00:00:00.000Z",
      timezone: "UTC",
      git: { inRepo: false },
    };
  },
};
await buildSystemPrompt({ ..., environmentProvider: fakeEnv });
```

## 2. 长程目标模式 — `packages/core/src/goal.ts`

`runGoal` 每轮注入 `goalPromptBody`（已 export），告诉模型"读 plan → 执行下一步 → 更新 plan → 判断完成条件"的 6 步协议，并要求在完成时输出以下三种状态之一：

| 标记 | 含义 | 后续行为 |
|------|------|----------|
| `<goal_status>completed</goal_status>` | 目标全部完成 | 循环结束，`status: "completed"` |
| `<goal_status>blocked</goal_status>` + `<goal_blocked_reason>...</goal_blocked_reason>` | 外部阻塞（凭证、用户决策） | 循环结束，`status: "blocked"`，reason 取自 `<goal_blocked_reason>` |
| 不出现 | 还有工作要做 | 进入下一轮 |

`COMPLETION_MARKERS` 与 `extractBlockedReason` 是 prompt 契约的一部分——调整完成判定时务必同步更新这里以及 `goalPromptBody`。

## 3. 子代理 — `packages/core/src/subagent.ts`

`task` 工具派发的子代理使用 `buildSystemPrompt` 构造的 system prompt，并在 `extra` 字段注入 `SUBAGENT_ROLE_BLOCK`（已 export）。该 block 明确：

- 子代理是父 agent 的 worker，不面对用户；
- 默认只读（read_file / grep / glob / ls / read_artifact），需要写权限时父 agent 必须显式 `tools=[...]`；
- 禁止嵌套子代理；
- 结论必须按 `### Findings / ### Key references / ### Recommendations`（或 `### Blocker`）格式输出。

`SUBAGENT_OBJECTIVE_FOOTER` 在 user message 末尾再次提醒结论格式，避免模型在前面的推理里跑题。

### 3.1 Agent Teams — `packages/core/src/teams.ts`

team 模式（`task` 的 `team` 字段，详见 [TEAMS.md](./TEAMS.md)）的成员本身就是子代理，
用的还是 `SUBAGENT_ROLE_BLOCK`；teams.ts 额外有三段**编排提示**，都是以 objective
的形式喂给某个成员的：

| 提示 | 函数 | 契约要点 |
|------|------|---------|
| 拆解 | `decomposePrompt` | 给 leader 的 roster 里每个成员标 `NEEDS-ASSIGNMENT` 或"已领活"；硬约束是"成员并行、互不通信、不给两人派重叠的文件"。输出走 `assignmentSchema` 的结构化 JSON（`{assignments:[{member, objective}]}`），由 `parseAssignments` 解析——改 schema 必须同步改解析 |
| 合并 | `summaryPrompt` | 把成员结论包成 `<member name role ok steps>` 块 + 文件冲突清单，要求报告覆盖：完成了什么、各人改了什么、矛盾与遗留、还剩什么。明确禁止 leader 重做成员的活 |
| 投票 | `votePrompt` | 候选包成 `<candidate>` 块，要求按"独立得出同一结论的人数 + 证据质量"判定，**不许按篇幅或语气自信度**判定。输出走 `VOTE_SCHEMA`，由 `parseVote` 解析 |

三段提示的解析失败都不是硬错误：拆解失败退回团队目标、合并/投票失败退回
`concat`，并在结果的 `notes` 里说明。改提示时优先保住这个降级路径。

## 4. 上下文压缩 — `packages/core/src/compaction.ts`

`callSummariser` 用 `SUMMARY_SYSTEM_PROMPT`（已 export）让 small model 压缩被丢弃的历史。摘要必须按以下七节顺序写：

1. TASK OVERVIEW
2. CURRENT STATE
3. KEY FILES AND SYMBOLS（`path:line — why it matters`）
4. DECISIONS MADE
5. ERRORS AND FIXES（含 verbatim 错误/命令）
6. OPEN THREADS
7. NEXT CONCRETE ACTION

整段上限 ~1200 token；verbatim 形式（命令、文件路径、错误消息、env 值、commit hash）必须原文保留，不允许意译。

## 5. 工具描述 — `packages/core/src/tools/*.ts`

每个工具的 `description` 字段是该工具对模型的说明，是工具行为契约的一部分。已重点扩充：

| 工具 | 强调点 |
|------|--------|
| `bash` | 用 `/bin/sh -c`、8KB artifact spill、5MB cap、禁用危险命令（rm -rf /、force-push 等）需显式授权 |
| `edit_file` | search/replace 优先于 `write_file`、四种匹配策略、ambiguous 错误处理 |
| `task` | 委派场景、何时不用、结论格式、team 与 fan-out 的区别及额外成本 |
| `plan_update` | 状态机语义、压缩时保留、3-8 步建议 |
| `plan_update` / `memory_write` / `read_artifact` / `read_file` / `glob` / `grep` / `ls` | 简洁但写清触发场景与不回退的边界 |

## 修改指引

| 想改 | 改哪里 |
|------|--------|
| agent 行为/风格 | `systemPrompt.ts` 静态前缀对应 § |
| 环境注入字段 | `src/env.ts`（接口）+ `systemPrompt.ts` 动态后缀 |
| 长程目标判定 | `goal.ts`（`goalPromptBody` / `COMPLETION_MARKERS`） |
| 摘要结构 | `compaction.ts`（`SUMMARY_SYSTEM_PROMPT`） |
| 子代理角色边界 | `subagent.ts`（`SUBAGENT_ROLE_BLOCK`） |
| team 拆解/合并/投票 | `teams.ts`（`decomposePrompt` / `summaryPrompt` / `votePrompt`，改 JSON 契约时同步 `parseAssignments` / `parseVote`） |
| 工具行为/约束 | `src/tools/<name>.ts` 的 `description` |
| 前端额外 prompt | `session/new` 的 `systemPromptExtra` 或项目根 `CODEPILOT.md` |
