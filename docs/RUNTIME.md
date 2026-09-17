# Agent Runtime（可替换的 agent 循环）

> agent 循环不再是一个硬编码的函数调用，而是 `AgentRuntime` 接口的一个实现，
> 通过注册表按名字解析。默认实现 `DefaultRuntime` 就是原来的 `runAgent()`；
> 插件可以提供自己的实现，接管"模型流式输出 → 解析工具调用 → 执行工具 → 再循环"
> 这整套编排逻辑。
>
> 对应 ROADMAP-NEXT §4.1。**不配置 `runtime` 时行为与之前完全一致。**

## 什么时候需要自定义 runtime

先问一句：**你要改的是「提示词」还是「循环本身」？**

| 需求 | 该用什么 |
|---|---|
| 换一套指令/人设/输出风格 | Skill、`systemPromptExtra`、output style |
| 限制某些工具、拦截某次调用 | 协作模式（chat/plan/agent）、权限规则、Hooks |
| 派一个子任务出去独立完成 | `task` 工具 / 自定义子代理 |
| **改变"何时调模型、调几次、如何选择结果"** | **自定义 runtime** |

只有最后一类才值得写 runtime：多轮搜索/投票、强制的产出格式校验、
把每轮结果喂给外部评分器，等等。这些都不是提示词能保证的性质。

## 接口

```ts
interface AgentRuntime {
  readonly name: string;
  /** 跑完一次 prompt（内部可以调用模型任意多次）。 */
  prompt(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult>;
  /** 可选：增量产出事件。缺省时宿主用 prompt() + onEvent。 */
  stream?(input: AgentRunInput, deps: AgentDeps): AsyncIterable<Event>;
  cancel(): void;
  state(): "idle" | "running" | "waiting_permission";
}

interface RuntimeFactory {
  readonly name: string;
  create(deps: RuntimeFactoryDeps): AgentRuntime;   // deps: { cwd, toolkit }
}
```

事件契约：runtime **必须**把过程事件通过 `deps.onEvent` 交出去，并在
`AgentRunResult.events` 里返回同一批事件。会话的持久化、流式推送、协议层
（JSON-RPC `event` 通知）都挂在这条通道上——不发事件的 runtime 在 UI 上看起来
就是"卡住了"。

取消通过 `deps.signal`（会话的 `AbortController`）传播，而不是靠 `cancel()`
自己实现：`cancel()` 只是给 runtime 一个清理的机会，内置循环已经处理了 signal。

## RuntimeToolkit：runtime 唯一需要的核心能力

`create()` 收到的 `deps.toolkit` 是宿主注入的一组原语。**插件 runtime 不要
`import "@codepilot/core"`**——插件是从 `~/.codepilot/plugins/` 加载的，那里解析
不到 core（就算解析到了也会是另一份副本）。需要的东西都在 toolkit 里：

| 成员 | 作用 |
|---|---|
| `runDefault(input, deps)` | 跑内置循环，等价于默认 runtime。包装型 runtime 的主力 |
| `runTool(call, deps, emit, mode?)` | 执行**一次**工具调用，走完整管道（见下） |
| `visibleTools(deps, mode)` | 某个协作模式下模型能看到的工具名 |
| `redactToolOutput(text)` | 抹掉凭证，落盘/进上下文前用 |
| `version` | ABI 版本，当前 `1` |

### 为什么必须用 `runTool`

`runTool` 依次做了这些事，顺序很重要：

```
模式门禁 → doom-loop 检测 → 权限检查 → PreToolUse hooks（可阻断/可改写入参）
        → Zod 入参校验 → 执行 → PostToolUse hooks（反馈追加给模型） → telemetry span
```

直接调 `tool.execute()` 能跑通，但会**静默绕过上面全部环节**：用户用 hook 明令
禁止的命令照样会执行，权限提示不会弹，审计 span 也不会有。这是自定义 runtime
最容易犯、也最不容易被发现的错误。

## 内置示例 runtime

导入 `@codepilot/core` 时这两个会自动注册（只是注册，不用就不生效，默认仍是
`default`）。它们本身就是参考实现——只用了 toolkit，没碰任何插件拿不到的东西。

### `audit` — 只读安全审计 + 强制报告格式

两条循环级的保证，不是提示词级的请求：

1. **只读，双重保证**：交给模型的工具表被过滤成只读集合，且每次工具调用出口
   再查一遍模式门禁。提示词里写"不要改文件"只是请求，这里是运行属性。
2. **报告格式被校验**：终稿缺少 `## Summary` / `## Findings` /
   `## Recommendations` 时，runtime 会额外花一轮要求按格式重写；仍不合格就发一个
   `error` 事件（`recoverable: true`）说明契约未达成，而不是把半成品当成审计结论。

```jsonc
// .codepilot/config.json
{ "runtime": "audit" }
```

选项（构造函数传入；自行注册 factory 时可覆盖）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `mode` | `"chat"` | 只读基线；`"plan"` 额外放开 `plan_update` / `memory_write` |
| `maxRepairAttempts` | `1` | 重写机会次数，`0` 表示不重写 |

### `mcts` — 搜索式探索

**名字要说清楚**：这是*扁平*蒙特卡洛搜索——一层展开后评分选择，不是带 UCT
和跨 prompt 树复用的完整 MCTS。四个阶段：

| 阶段 | 做什么 |
|---|---|
| expand | N 个**只读** rollout，每个被推向不同的解题角度 |
| simulate | 一次评分调用，按 correctness / 契合度 / 风险 / 工作量 给 0–10 分 |
| select | 取最高分，同分取靠前的候选 |
| exploit | 用胜出方案在会话原本的模式下真正干活 |

探索阶段刻意只读：N 个循环同时改一棵工作树会互相覆盖，而搜索的意义正是
"在动手之前比较几种方案"。只有 exploit 阶段能改东西。

评分结果会作为一条 `[mcts runtime]` 消息落进 transcript——一次丢弃了四种方案的
运行如果不留痕，事后没法复盘。

**代价**：每个 prompt 要 N + 2 次模型运行（N 次探索 + 1 次评分 + 1 次执行）。
这就是它的交易条件：用 token 换"不把模型想到的第一个方案当定论"。

```jsonc
{
  "runtime": "mcts",
  "runtimeOptions": {
    "mcts": { "candidates": 3, "exploreMode": "plan", "proposeOnly": false }
  }
}
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `candidates` | `3` | 探索几种方案，clamp 到 2–5 |
| `exploreMode` | `"plan"` | 探索阶段的协作模式（`"chat"` / `"plan"`） |
| `proposeOnly` | `false` | 只给出选中的方案，跳过 exploit 阶段 |

## 插件提供 runtime

在 `plugin.json` 里声明 `runtime`：

```jsonc
{
  "name": "runtime-example",
  "description": "…",
  "version": "1.0.0",
  "runtime": {
    "module": "./runtime.mjs",   // 相对插件目录
    "name": "primer",            // 可选，覆盖 factory 自己的 name
    "default": true              // 可选，直接接管会话 runtime
  }
}
```

也支持字符串简写 `"runtime": "./runtime.mjs"`（用 factory 自己的 `name`）。

模块需要导出一个 `RuntimeFactory`，位置可以是 `default` 导出、或具名的
`factory` / `runtimeFactory` 导出：

```js
// runtime.mjs — 完整可运行的例子见 plugins/runtime-example/
export default {
  name: "primer",
  create: (deps) => new PrimerRuntime(deps.toolkit),
};
```

### 加载与解析顺序

`createSession()` 会自动完成这一切：

```
discoverPlugins(cwd)           项目级 .codepilot/plugins → 用户级 ~/.codepilot/plugins
      ↓
loadPluginRuntimes()           动态 import 各 runtime 模块，注册 factory
      ↓
runtime 名字定序               opts.runtime → config.runtime → 插件的 default
      ↓
Session.getRuntime()           首次 prompt 时按名字解析并缓存实例
```

手动控制时用 `initPluginRuntimes(cwd, opts)`，它返回注册结果、逐插件的错误、
以及插件声明的 `defaultRuntime`。

几条刻意设计的行为：

- **未知名字直接抛错**，不会退回默认循环。一个配错的 runtime 静默降级成普通
  agent，比报错难查得多。
- **加载失败的插件不会成为 default**，否则一条加载告警会变成下一次 prompt 的
  硬失败。失败原因收集在 `errors` 里（`createSession` 会写进日志）。
- **两个插件同时声明 default 会抛错**，让用户显式设置 `config.runtime` 消歧。
- `default` runtime 不可被注销或覆盖。
- 宿主可以用 `createSession({ pluginRuntimes: false })` 完全跳过插件发现——
  runtime 模块是在宿主进程里跑的宿主代码，不想要插件的宿主不该被迫加载它们。

> **安全**：runtime 模块拥有完整的 Node 权限（fs、网络、子进程），和 hook 脚本
> 同级。只安装可信来源的插件。

## Hooks 与 runtime 的关系

哪些 hook 由谁触发，分界线是"在循环内还是循环外"：

| Hook | 触发者 | 自定义 runtime 需要做什么 |
|---|---|---|
| `SessionStart` / `UserPromptSubmit` / `Stop` / `PreCompact` / `PostCompact` | 会话层（`Session.prompt`） | 不用管，自动触发 |
| `PreToolUse` / `PostToolUse` | 工具执行管道 | **用 `toolkit.runTool` 执行工具**即可；自己调 `execute()` 就丢了 |
| `SubagentStop` | `task` 工具 | 不用管 |

## 相关 API

```ts
import {
  // 注册表
  runtimeRegistry, RuntimeRegistry, DEFAULT_RUNTIME_NAME,
  // 默认实现 + 工具箱
  DefaultRuntime, createRuntimeToolkit,
  // 示例 runtime
  registerBuiltinRuntimes,
  AuditRuntime, auditRuntimeFactory, missingAuditSections,
  MctsRuntime, mctsRuntimeFactory, parseScores, selectCandidate,
  // 插件侧
  initPluginRuntimes, loadPluginRuntimes, pluginDefaultRuntime,
} from "@codepilot/core";

import type {
  AgentRuntime, AgentRuntimeState, RuntimeToolkit,
  RuntimeFactory, RuntimeFactoryDeps, RuntimeResolveOptions,
  AuditRuntimeOptions, MctsCandidate, MctsRuntimeOptions,
} from "@codepilot/core";
```

## 相关文档

- [PLUGINS.md](./PLUGINS.md) — 插件打包、发现、安装
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 会话与 agent 循环的整体结构
- [CONFIG.md](./CONFIG.md) — `runtime` / `runtimeOptions` 的配置分层
- [PROMPTS.md](./PROMPTS.md) — 系统提示词的静态前缀 / 动态后缀分层
