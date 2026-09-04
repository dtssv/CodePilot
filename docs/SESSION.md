# 会话 / 检查点 / 长程目标

> 本文件描述 `@codepilot/core` 中会话、检查点与长程目标三大子系统的设计
> 与 API。配套规范：[API.md](./API.md)（导出符号）、[ARCHITECTURE.md](./ARCHITECTURE.md)、
> [MEMORY.md](./MEMORY.md)（记忆文件格式）。

## 设计目标

- **事件溯源**：所有会话状态都以 `Event` JSONL 追加在 `~/.codepilot/sessions/<id>.jsonl`。
  这意味着「恢复」是免费的：只需 `createSession({ sessionId })` 即可重放历史。
- **分层压缩**：
  1. `compaction.ts` 在单次会话内做 *in-session* 内存压力管理（折叠 tool_result、向小模型要摘要）。
  2. `checkpoints.ts` 做 *cross-session* 持久化（每个会话一份 7 段 markdown）。
  两者职责互补：compaction 让模型能继续跑，checkpoint 让下次会话能续上。
- **可恢复的长程目标**：`goal.ts` 的 `runGoal` 在每轮跑完后把 round 状态
  写入 checkpoint，从而中断恢复不丢上下文。
- **结构化记忆**：`memory.ts` 把 `CODEPILOT.md` / `MEMORY.md` 解析为四个固定分节
  （Project context / Rules / Architecture decisions / Discovered durable knowledge），
  写时按节定位，读时按节截断。

## 模块

```
src/
├── session.ts     ← 会话生命周期、provider/工具装配、JSONL 持久化
├── compaction.ts  ← 上下文压缩：tool_result 折叠 + 小模型摘要
├── checkpoints.ts ← 跨会话检查点：7 段 markdown，token/turn 触发
├── memory.ts      ← CODEPILOT.md / MEMORY.md 解析、写入、按节摘要
├── goal.ts        ← 长程目标循环 + 每轮检查点
├── tokens.ts      ← 分段 token 估算 + 模型上下文窗口表
└── tools/
    ├── memory_write.ts  ← memory_write 工具（已支持 `section` 参数）
    └── artifacts.ts     ← 工件存储（writeJson / readJson 辅助）
```

## 数据流

```
用户 prompt
  → runAgent (agent.ts)
      → 调 ChatProvider.stream
      → 收集事件、跑工具
      → 每轮结束 emit onTokenEstimate(tok, turn, window)
  → Session.prompt 后半段:
      1. auto-title（首次 prompt 后；小模型失败回退截断）
      2. maybeCompact() — token 超阈值时折叠/摘要
      3. maybeCheckpoint() — token 或 turn 超阈值时写 .codepilot/checkpoints/<id>.md
  → 下一轮 prompt 注入 checkpoint 摘要到 system prompt
```

## API 一览（与 API.md 偏差）

| 符号 | 类型 | 备注 |
|---|---|---|
| `Session` | class | `getTitle()` / `setTitle(t)` / `getRichSummary()` 新增；`prompt()` 内置 checkpoint hook |
| `createSession` | function | 不变 |
| `listSessions` | function | **返回 `RichSessionSummary`（含 `mode` / `model` / `messageCount`），非 `SessionSummary`** |
| `searchSessions(query, { cwd?, limit? })` | function | **新增**：按 title + 内容匹配 |
| `exportSession(id, "markdown" \| "jsonl")` | function | **新增** |
| `deleteSession(id)` | function | **新增**（测试辅助） |
| `RichSessionSummary` | interface | `SessionSummary` 的扩展类型（mode/model/messageCount） |
| `SessionExportFormat` | type | `"markdown" \| "jsonl"` |
| `runGoal` | function | 现有签名；接受额外的 `onCheckpoint` 字段（见下） |
| `GoalRunOptionsEx` | interface | **新增**：`onCheckpoint(info)`；传 `as` 即可赋给 `GoalRunOptions` |
| `GoalCheckpointInfo` | interface | round / status / reason / blockedReason / path |
| `GoalRunResult.blockedReason` | field | **新增**（通过对象扩展添加，不破坏 `types.ts`） |

`onCheckpoint` 的写法：

```ts
await runGoal({
  cwd,
  objective: "重构 typechecker",
  onCheckpoint: async (info) => {
    console.log(info.round, info.status, info.path);
  },
} as GoalRunOptionsEx);
```

> 我们没有修改 `types.ts`（被列为禁区），所以新字段通过 `GoalRunOptionsEx`
> 类型扩展提供；调用者用 `as GoalRunOptionsEx` 或直接传完整对象即可。
> `SessionSummary` 也保持兼容——`listSessions` 现在返回 `RichSessionSummary`
> 但它继承自 `SessionSummary`，旧调用方读取的 4 个字段不变。

## 检查点机制（detail）

每个会话在 `.codepilot/checkpoints/<sessionId>.md` 写一份 7 段 markdown：

```
# Checkpoint for <sessionId>
## Active intent        ← 用户最近一次承诺式请求
## Next action          ← 单一最有用下一步
## Task tree            ← plan 步骤 + 状态图标
## Current work         ← 最近 6 轮 user/assistant 摘要
## Files touched        ← tool_call/result 中提取的路径
## Errors & fixes       ← error / tool_result.isError / 助手自述 fix
## Decisions            ← 「decided to / we will / 决定 / 采用」等模式
```

**触发条件**（任一满足）：
- 当前事件累计 token 数 ≥ `lookupContextWindow(model).compactionThreshold`（默认窗口的 80%）。
- 距上次 checkpoint 累积 ≥ 6 轮（`turnsThreshold`）。
- `runGoal` 每轮强制写一次 `### Round N — <status>` 块。

**摘要注入**：下次会话启动时，`Session.init()` 检测到 checkpoint 存在，
`Session.rebuildSystemPrompt()` 把 `summariseCheckpointForPrompt(checkpoint)`
追加到 system prompt 的 `extra` 段。这意味着「恢复」是**默认行为**——
只要给 `createSession` 传同一个 `sessionId`，新会话就自动看见 checkpoint 摘要，
无需 `resume` 标志。

**与 compaction 的边界**：

| 维度 | compaction | checkpoint |
|---|---|---|
| 触发 | 内存预算（事件 token 总和 ≥ 上下文窗口 80%） | 内存预算 *或* turn 计数 |
| 输出 | 修改 events 数组（折叠 tool_result + 插入 `compaction` 事件） | 写入磁盘 markdown |
| 范围 | 单次会话内 | 跨会话 |
| 作用 | 让模型继续跑 | 让下次会话续得上 |

## 长程目标（detail）

```
runGoal({
  objective,
  cwd,
  maxRounds = 50,
  onRound?,           ← 旧 API
  onCheckpoint?,      ← 新 API（GoalRunOptionsEx）
})
  for round = 1..maxRounds:
    appendCheckpointRound(round, "running")
    session.prompt(renderRoundPrompt(round, objective))
    if model emits <goal_status>completed</goal_status>:
      appendCheckpointRound(round, "completed", reason)
      return { status: "completed", reason }
    if model emits <goal_status>blocked</goal_status><goal_blocked_reason>...</goal_blocked_reason>:
      blockedReason = extract it
      appendCheckpointRound(round, "blocked", reason, blockedReason)
      return { status: "blocked", reason, blockedReason }
  return { status: "round_limit", reason }
```

`blockedReason` 是结构化字段：模型输出 `<goal_blocked_reason>...</goal_blocked_reason>`
时被解析并存到 `GoalRunResult.blockedReason`，同时通过 `onCheckpoint` 传给监听方，
并写入 checkpoint 文件的 `**Blocked reason:**` 行。

## 自动标题

第一次 `prompt()` 完成后：
1. 调 `buildSmallProvider(config).stream(...)`，system prompt 限定 ≤10 中文字符 / ≤60 ASCII 字符。
2. 失败或超时回退：取首条 user 消息的首句、截断到 60 字符。
3. 写入 `<sessionId>.title` sidecar（`~/.codepilot/sessions/`），`listSessions` 优先读 sidecar。
4. 也作为 checkpoint markdown 的 `# Checkpoint for <sessionId>` 行。

## Token 估算

`tokens.ts` 不依赖第三方库；按字符类分桶：

| 类别 | 估算 | 备注 |
|---|---|---|
| CJK（含日韩） | 1 token / 字符 | `0x4E00-0x9FFF` 等 |
| 英文 / 拉丁 / 西里尔 / 希腊 | 0.75 token / 单词 | 空格分隔累计 |
| 代码标点 `{}[]()<>:=;,.+-/*&|^!~?'"@#$\\` | 1 token / 3 字符 | 保守 |
| 空白 | 0 | `text.trim().length === 0` 走快路径 |
| 单字符 | 至少 1 token | `Math.max(1, ceil(est))` |

模型上下文窗口表覆盖：claude (opus/sonnet/haiku 4 & 3.5)、gpt-4o/4-turbo/4.1/3.5/o1/o3、
deepseek (chat/r1)、glm-4 (plus/long)、kimi-k2、moonshot-v1、copilot。
未知模型默认 128k，阈值 80%（102.4k）。

## 公开 API 偏差（与 docs/API.md）

| 位置 | API.md | 实际 | 备注 |
|---|---|---|---|
| `listSessions` 返回类型 | `SessionSummary[]` | `RichSessionSummary[]` | 继承自 `SessionSummary`，旧字段不变，新增 `mode?` / `model?` / `messageCount` |
| `GoalRunOptions.onCheckpoint` | 不存在 | 通过 `GoalRunOptionsEx` 扩展提供 | 因 `types.ts` 不可改 |
| `GoalRunResult.blockedReason` | 不存在 | 通过对象扩展添加 | 同上 |
| `Session` 公共方法 | 无 title 相关 | 新增 `getTitle()` / `setTitle()` / `getRichSummary()` | 不影响既有调用 |
