# 记忆：CODEPILOT.md / MEMORY.md

> 本文件描述 `@codepilot/core` 中记忆子系统的文件格式、写入路径与摘要策略。
> 配套规范：[SESSION.md](./SESSION.md)（检查点）、[API.md](./API.md)（导出符号）。

## 概念

- **项目级记忆** `<repo>/CODEPILOT.md` —— 跟随仓库，跨开发者的项目知识。
- **用户级记忆** `~/.codepilot/MEMORY.md` —— 跟随用户，跨项目。
- 两个文件结构相同，由 `MEMORY_SECTIONS` 常量定义四个分节。

## 文件结构（4 个固定分节）

```markdown
# (optional preamble)

## Project context
…用户与项目目标说明…

## Rules
- 硬约束 / 永不破例的规则
- 工具使用约束（如 "no try/catch — early-return"）

## Architecture decisions
- 重大设计选择 + 一句理由
- 决策应能跨会话继承

## Discovered durable knowledge
- 跨会话依然成立的事实
- 库 / 工具的边界与限制
- 项目特有的不变量
```

写入 `memory_write` 工具时，`section` 字段是以下四个值之一：

| `section` 值 | 何时用 |
|---|---|
| `Project context` | 描述「这是什么项目、它要做什么」 |
| `Rules` | 用户陈述的硬约束（"always X", "never Y"） |
| `Architecture decisions` | 选型决策（"chose X over Y because…"） |
| `Discovered durable knowledge` | 跨会话仍然成立的发现 |

省略 `section` 时，sink 用启发式分类器（基于 title + content 关键词）选一个分节。

## 解析容错

`parseMemory` 是宽容的：

- 完全空文件 → 所有分节为空。
- 没有 `## <title>` 头 → 整文当 Project context 读，`unstructured = true`。
- 不在四个固定分节里的 `## <title>` 头 → 保留到 `extras[]`，写回时按出现顺序保留。
- 有 preamble（`##` 之前的内容）→ 也存到 `extras[]`，标题为 `_preamble`。

这样旧的不分节文件仍能读，向下迁移也只需再调用 `renderMemory` 一次。

## 摘要注入（系统提示）

每次会话启动，`Session.rebuildSystemPrompt()` 调用 `summariseMemory(contents, 4000)`：

- 文件 ≤ 200 行：简单前缀 + `...truncated` 标记。
- 文件 > 200 行：按分节各自截断，保留每个分节前 20 行非空内容。
  对 `Project context` / `Rules` / `Architecture decisions` / `Discovered durable knowledge`
  四个分节都这样做，确保模型启动时仍能看到完整的章节结构而不是一团乱码。

## 写入（FileMemorySink）

```ts
const sink = new FileMemorySink(cwd);
await sink.write("project", "no try/catch", "Use early-return; no try/catch.", "Rules");
await sink.write("user", "Bun quirk", "Bun's Read has no native tail-N.", "Discovered durable knowledge");
```

写时行为：
1. 读出现有文件 → 解析为 `ParsedMemory`。
2. 把新块（`### <title> (<date>)\n\n<body>\n`）追加到目标分节的末尾。
3. 用 `renderMemory` 重新序列化整份文件，确保 4 个分节都存在（空分节写 `_(none yet)_`）。
4. 写回磁盘。

这意味着「追加」不是简单 append —— 旧文件会被规范化到 4 分节结构。

## API 一览

| 符号 | 描述 |
|---|---|
| `readMemory(cwd)` | 读 project + user 记忆 |
| `FileMemorySink(cwd).write(scope, title, content, section?)` | 写入；`section` 可选 |
| `summariseMemory(contents, maxChars=4000)` | 给 system prompt 用的摘要 |
| `summariseMemoryText(text, maxChars)` | 单文件智能摘要（>200 行按分节） |
| `parseMemory(text)` | 解析为 `ParsedMemory` |
| `renderMemory(parsed)` | 反向序列化 |
| `classifySection(title, content)` | 启发式选分节 |
| `MEMORY_SECTIONS` | 常量：四个分节名 |
| `memory_write` 工具 | 工具侧入口（`session.ts` 注入 sink） |

## 与检查点的关系

`memory.ts` 和 `checkpoints.ts` 是两个不同的持久化层：

| 维度 | 记忆（memory） | 检查点（checkpoint） |
|---|---|---|
| 文件 | `CODEPILOT.md` / `MEMORY.md` | `.codepilot/checkpoints/<id>.md` |
| 粒度 | 项目级 / 用户级（与 session 无关） | 每会话一份 |
| 写入者 | 助手通过 `memory_write` | Session 自动 + 助手可显式 |
| 注入时机 | 每次会话启动注入摘要 | 恢复同一 sessionId 时注入 |
| 用途 | 跨会话、跨开发者的事实 | 跨会话、单用户的轨迹 |

两者的分节结构有意保持一致：checkpoint 的 `## Decisions` 对应 memory 的
`## Architecture decisions`，checkpoint 的 `## Errors & fixes` 可以被
`memory_write(..., "Discovered durable knowledge")` 提升。
