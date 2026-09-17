# Agent Teams（多 agent 协作）

> 一个目标、多个角色、一份合并后的结论。`task` 工具的 `team` 模式让 leader
> 把目标拆成分工，成员并行执行，同一个文件被两个人改会被检测出来，最后按
> 声明的策略合并。
>
> 对应 ROADMAP-NEXT §4.2。**不传 `team` 时 `task` 行为与之前完全一致。**

## 先搞清楚：team 还是 tasks？

`task` 已经有 `tasks: [...]` 能并行跑多个子代理了。两者的区别不是"几个
agent"，而是**这些 agent 是不是在干同一件事**：

| | `tasks`（fan-out） | `team` |
|---|---|---|
| 目标 | N 个互不相干的目标 | **1 个**共同目标 |
| 分工 | 你自己写好每个目标 | leader 可以调研后自己拆 |
| 工作区 | 各自 cwd 或各自 worktree | 可共享**一个** worktree |
| 冲突 | 不管 | 同一文件被多人写 → 报冲突 |
| 结果 | N 份结论，你自己读 | 按策略合并成 1 份 |
| 成本 | N 次子代理 | N + 拆解 1 次 + 合并 1 次 |

**不需要拆解、也不需要合并，就别用 team**——它比 `tasks` 多烧两次子代理。
适合 team 的典型形状："这个改动要同时动前端、后端、迁移脚本，而且三边要
对得上"。

## 角色

| 角色 | 工具面 | 职责 |
|---|---|---|
| `leader` | 只读（`explore`） | 调研 + 拆解分工 + 写最终报告。最多一个 |
| `worker` | 可写（`worker`） | 执行分到的活 |
| `specialist` | 可写 | 有明确专长的 worker（安全/性能/…），执行路径相同，区别只在于 leader 怎么给它派活、日志怎么读 |

leader 固定只读，理由不是"省钱"：**leader 一边改文件、worker 一边改同一批
文件，正是 team 这套结构要避免的冲突**。要改代码就多加一个 worker。

成员之间**不能互相通信**，也不能再开 team（和所有子代理一样）。分工必须是
可以独立完成的——这是拆解提示里写死的约束。

## 用法

```jsonc
// 最小：自己写好分工，没有 leader → 默认 concat 合并
{
  "objective": "把 config loader 换成 zod 校验",
  "team": [
    { "role": "worker", "name": "core", "objective": "改 config.ts 的 schema 与解析" },
    { "role": "worker", "name": "callers", "objective": "更新所有调用点与测试" }
  ]
}
```

```jsonc
// 让 leader 拆：worker 不写 objective
{
  "objective": "给项目加上 OpenTelemetry 追踪",
  "team": [
    { "role": "leader" },
    { "role": "worker", "name": "backend" },
    { "role": "worker", "name": "frontend" },
    { "role": "specialist", "name": "perf", "objective": "确认埋点不会明显拖慢热路径" }
  ],
  "shared_worktree": true
}
```

已经写了 `objective` 的成员不会被 leader 覆盖——leader 只给标了
`NEEDS-ASSIGNMENT` 的成员派活，并且知道其他人已经领了什么，不会重复安排。

成员字段：`role`（必填）、`objective`、`name`、`agent_type`、`tools`、
`model`、`maxSteps`。`agent_type` 缺省时 leader 用 `explore`、其他人用
`worker`；也可以填自定义子代理的名字（`.codepilot/agents/*.md`）。

## 合并策略

| `merge_strategy` | 什么时候用 | 做了什么 |
|---|---|---|
| `leader_summary` | 分工协作（**有 leader 时默认**） | leader 拿到所有成员结论 + 冲突清单，写一份报告：完成了什么、各人改了什么、哪里互相矛盾、还剩什么 |
| `voting` | 多人**独立解同一个问题** | 评审按「几个人独立得出同一结论」+ 证据质量选出一份原样返回，附票数与理由 |
| `concat` | 只想看原文（**无 leader 时默认**） | 每个人的结论逐字列出，不额外调模型 |

`voting` 的成员 objective 应该是同一个问题的不同切入角度；成功成员少于 2 个
时它会退回 `concat` 并在 notes 里说明。没有 leader 却要求 `leader_summary`
或 `voting` 时，会临时用一个只读的 `team-judge` 来合并，同样记在 notes 里。

**任何一次合并调用失败都会退回 `concat`**，而不是让整个 team 白跑——成员的
结论已经拿到了，没有理由丢掉。返回结果里的 `mergeStrategy` 是实际生效的策略。

## 共享工作区

`shared_worktree: true` 时，所有成员跑在**同一个** linked git worktree 里
（新分支，从当前 HEAD 拉），而不是你的工作目录。成员之间因此能看到彼此的
改动（比如后端先建好的类型），你的工作树则完全不受影响。

结束时 worktree 目录会被删掉，**分支保留**——那是这次协作的产出。返回内容里
带分支名和 `git diff --stat`，你自己决定 review 还是 merge。

不是 git 仓库、或者创建失败时会**退回父 cwd** 并在 notes 里说明原因，而不是
直接失败。注意这种情况下成员会直接改你的工作树。

每个成员各自开 worktree 是**不支持**的：那样成员之间互相看不见，也就谈不上
协作。需要那种隔离的话用 `tasks` + `isolation: "worktree"`。

## 冲突检测

每个成员的 `write_file` / `edit_file` / `apply_patch` / `notebook_edit` 调用
都会被记录目标路径。**同一路径出现在两个以上成员名下**就是一次冲突：

- 立刻发一条 `team_message`（kind `conflict`）；
- 进入 leader 的合并提示，要求它在报告里明确指出；
- 出现在最终结果的 `File conflicts` 段落里。

这是"**谁写过同一个文件**"级别的检测，不是行级 diff 合并：后写的人会覆盖
先写的人，工具只负责让你知道这件事发生了。真正要防冲突，靠的是拆解阶段
不给两个人派重叠的活。

## team_message 事件

编排过程的每一步都会发 `team_message` 事件：

```ts
{
  type: "team_message";
  from: string;   // 成员名，或 "team"（编排器通知）
  to: string;     // 成员名，或 "all"（广播）
  content: string;
  timestamp: number;
  kind?: "assignment" | "conclusion" | "conflict" | "summary" | "status";
}
```

这些事件会被持久化、推给 TUI / 协议客户端（TUI 里显示成 `⇄ [kind] from → to`），
**但对模型不可见**——`compactTranscriptToProviderMessages` 会忽略它们，
compaction 的 token 估算也算它 0。父 agent 从 `task` 的返回值里了解结果，
和其他任何工具一样。团队内部的过程日志是给**人**复盘用的，没道理让它去挤
父 agent 的上下文。

工具能发这种事件靠的是 `ToolContext.emitEvent`：它直连宿主（持久化 + 推流），
不进 agent 循环自己的事件数组。

## 返回给父 agent 的内容

```
Team finished: 3/3 members succeeded, merge strategy "leader_summary", 1 file conflict(s).

<合并后的报告>

[shared worktree — branch cp-team-a1b2c3d4]
 4 files changed, 120 insertions(+), 12 deletions(-)
The worktree directory was removed; the branch is kept for you to review or merge.

[notes]
- leader did not produce an assignment for perf; they received the team objective instead
```

`notes` 专门用来放**降级**：worktree 没建起来、拆解漏了人、合并策略退回
concat……这些都不会静默发生。

## 编程接口

```ts
import { runTeam, type TeamSpec } from "@codepilot/core";

const result = await runTeam(
  {
    objective: "migrate to zod",
    members: [{ role: "leader" }, { role: "worker", name: "core" }],
    merge_strategy: "leader_summary",
    shared_worktree: true,
  },
  { runner, cwd, emitEvent, semaphore, signal },
);
// result: { members, conflicts, summary, mergeStrategy, worktree?, notes }
```

`runner` 是 `SubagentRunner`（`createSubagentRunner()` 产出的那个），
`semaphore` 传会话共用的那个信号量，这样 team 不会突破会话的子代理并发上限。
校验失败（没有成员 / 多个 leader / 只有 leader / 超过 8 人 / 既没有成员
objective 也没有 leader+目标）会在跑任何成员之前抛错。

## 限制

- 成员之间**不能通信**，只能通过 leader 的拆解与合并间接协调。
- 冲突检测是**文件级**的，且只看工具调用参数——成员用 `bash` 里的
  `sed -i` 改文件，检测不到。
- `voting` 靠的是评审模型的判断，不是真正的多数表决；票数只反映它认为
  哪些结论彼此一致。
- 拆解与合并各占一次子代理调用，团队规模上限 8 人。
- 成员**不能**再开 team 或 `task`（子代理禁止嵌套）。

## 相关文档

- [`docs/RUNTIME.md`](./RUNTIME.md) — 替换 agent 循环本身
- [`docs/PLUGINS.md`](./PLUGINS.md) — 自定义子代理与插件
- [`docs/SESSION.md`](./SESSION.md) — 会话、事件与持久化
