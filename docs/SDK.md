# CodePilot Agent SDK（`@codepilot/sdk`）

> 把 CodePilot agent 嵌进脚本、CI 流水线和后端服务。SDK 在
> `@codepilot/core` 的 `Session` 之上包了一层干净的 Promise 风格 API，
> 接口设计对齐 claude-code SDK：创建 `Agent` → `prompt()` / `stream()` →
> `dispose()`。

## 概述

SDK 面向**程序化调用**场景：

- **脚本** —— 一次性任务（lint 修复、批量重构、commit message 生成）。
- **CI 流水线** —— PR 审查、测试失败诊断、代码质量门禁。
- **后端服务** —— 把 agent 能力作为 API 暴露给上层产品。

与 core 的关系：`Agent` 内部就是一个 `Session`，SDK 负责加载配置、
初始化 session、把核心事件流收敛成 `AgentResult` / `StreamEvent`，
并在未提供权限处理器时默认进入 **yolo 模式**（自动放行所有工具调用，
适合 CI）。需要完整控制权时，仍可通过 `agent.session` 访问底层 `Session`。

## 安装

```bash
npm install @codepilot/sdk
```

在 monorepo workspace 内使用：

```jsonc
// package.json
{ "dependencies": { "@codepilot/sdk": "workspace:*" } }
```

SDK 是 ESM-only 包（`"type": "module"`），入口为 `dist/index.js`。

## 快速上手

一次性任务用 `run()`——创建、提问、回收一步完成：

```ts
import { run } from "@codepilot/sdk";

const { text, usage } = await run({
  cwd: "/my/project",
  prompt: "修复 src/ 下所有 lint 错误",
});
console.log(text);
console.log(`cost: $${usage.costUSD}`);
```

多轮交互用 `Agent.create()`：

```ts
import { Agent } from "@codepilot/sdk";

const agent = await Agent.create({
  cwd: "/my/project",
  model: "claude-sonnet-4-5",
});

const r1 = await agent.prompt("总结这个仓库的结构");
console.log(r1.text);

const r2 = await agent.prompt("把 core 包的入口文件列出来"); // 同一会话，有上下文
console.log(r2.text);

await agent.dispose();
```

流式输出：

```ts
for await (const event of agent.stream("解释这个代码库")) {
  if (event.type === "text") process.stdout.write(event.text);
}
```

## API 参考

### `Agent.create(opts?)`

加载配置、初始化 session，返回可用的 `Agent` 实例。

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | 工作目录。 |
| `model` | `string` | 配置的 `model` 或 `"claude-sonnet-4-5"` | 模型 id。 |
| `config` | `Partial<CodepilotConfig>` | — | 显式配置覆盖，浅合并到加载出的配置之上。 |
| `sessionId` | `string` | `randomUUID()` | 传入已有 id 可恢复会话。 |
| `agentMode` | `AgentMode` | `"agent"` | 初始协作模式（`chat` / `plan` / `agent`）。 |
| `onPermissionRequest` | `(req) => Promise<PermissionDecision>` | yolo 自动放行 | 权限处理器，详见下文「权限处理」。 |
| `onAskUser` | `(req) => Promise<QuestionAnswers>` | — | 结构化提问处理器（`ask_user_question` / `plan_done`）。未提供时该工具返回显式错误，模型自行降级。 |
| `noConfigFiles` | `boolean` | `false` | 跳过配置文件加载，只使用 `config` 选项。适合测试与多租户服务。 |
| `replay` | `string` | — | Replay 模式：指向 transcript JSONL 路径，无密钥测试，详见下文「Replay 模式」。 |

配置加载遵循 core 的分层优先级（defaults → 用户级 → 仓库级 → 环境变量 →
调用方显式），详见 [CONFIG.md](./CONFIG.md)。

### `agent.prompt(text, images?)`

发送一条 prompt 并等待 agent 跑完整个循环，返回 `AgentResult`：

```ts
const result = await agent.prompt("跑一遍测试并修复失败项");
if (result.hadErrors) console.warn("中途出现可恢复错误");
console.log(result.text, result.toolCallCount, result.usage.costUSD);
```

`images` 为可选的 `ImageAttachment[]`，用于多模态输入。

### `agent.stream(text, images?)`

异步生成器，实时产出 `StreamEvent`，agent 结束后产出 `{ type: "done" }`：

```ts
for await (const event of agent.stream("审查这次改动")) {
  switch (event.type) {
    case "text":        process.stdout.write(event.text); break;
    case "tool_call":   console.error(`→ ${event.name}`); break;
    case "tool_result": if (event.isError) console.error(`✗ ${event.name} failed`); break;
    case "error":       console.error(`error: ${event.message}`); break;
    case "done":        console.error("\nfinished"); break;
  }
}
```

事件在 prompt 结束后仍会继续 drain 队列，保证不丢尾部事件。

### `agent.dispose()`

释放 session 资源（MCP 连接、后台任务、日志句柄等）。幂等，重复调用安全。
**用完必须调用**——见「最佳实践」。

### `agent.id`

只读属性，返回 session id。可保存下来，之后用
`Agent.create({ sessionId })` 恢复同一会话：

```ts
const agent = await Agent.create({ cwd: "." });
saveToDb(agent.id);
await agent.dispose();

// 之后的进程里恢复：
const resumed = await Agent.create({ cwd: ".", sessionId: loadFromDb() });
```

### `run(opts)`

一次性便捷函数：`Agent.create()` → `prompt()` → `dispose()`，内部用
`try/finally` 保证回收。

```ts
export interface RunOptions extends AgentCreateOptions {
  prompt: string;
  images?: ImageAttachment[];
}

const { text } = await run({ cwd: ".", prompt: "lint and fix" });
```

接受 `AgentCreateOptions` 的全部选项（含 `replay`、`onPermissionRequest`）。

## 类型

```ts
/** Agent 创建选项（见上表）。 */
export interface AgentCreateOptions {
  cwd?: string;
  model?: string;
  config?: Partial<CodepilotConfig>;
  sessionId?: string;
  agentMode?: AgentMode;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  onAskUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
  noConfigFiles?: boolean;
  replay?: string;
}

/** prompt() 的返回结果。 */
export interface AgentResult {
  text: string;          // 最终助手文本
  hadErrors: boolean;    // 循环中途是否出现过 error 事件
  toolCallCount: number; // 本轮工具调用次数
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    costUSD?: number;    // 未知模型为 undefined（"未定价"，不是 0）
  };
  sessionId: string;     // 可用于恢复会话
}

/** stream() 产出的事件。 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; content: string; isError: boolean }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "status"; status: string }
  | { type: "done" };

/** run() 的选项。 */
export interface RunOptions extends AgentCreateOptions {
  prompt: string;
  images?: ImageAttachment[];
}
```

注意 `hadErrors` 与 HEADLESS 模式 `subtype` 的语义一致：中途的可恢复错误
（流断流、工具异常）只翻转 `hadErrors`，只要 `prompt()` 正常返回就不算失败。

## 权限处理

SDK 默认**不提供交互 UI**，因此未传 `onPermissionRequest` 时进入 yolo 模式——
所有工具调用自动放行。这是为 CI / 自动化设计的默认值，使用时建议配合
项目级 `permissions.deny` 规则兜底：

```jsonc
// .codepilot/config.json
{ "permissions": { "deny": ["bash(rm -rf *)", "bash(git push *)"] } }
```

交互式场景（如后端服务代表真实用户执行）应提供自定义处理器：

```ts
const agent = await Agent.create({
  cwd: ".",
  onPermissionRequest: async (req) => {
    // req 包含工具名、输入、匹配到的规则等
    const ok = await askUserOverWebSocket(req); // 你自己的审批通道
    return ok ? "allow" : "deny";
  },
  onAskUser: async (req) => {
    // ask_user_question / plan_done 的结构化提问
    return await collectAnswersFromUser(req);
  },
});
```

`PermissionDecision` 为 `"allow" | "deny" | "always"` 等；规则语法与求值顺序
（deny → ask → allow → mode 默认）见 [CONFIG.md](./CONFIG.md) 的权限规则一节。
配置文件中的 deny 规则**在 yolo 下依然生效**。

## Replay 模式

`replay` 选项把底层 provider 换成 `ReplayProvider`：不调用真实模型 API，
而是从一份录制好的 session transcript（JSONL，每行一个核心 `Event`）依次
回放 assistant 回合。工具调用仍由真实工具执行（文件 / bash 副作用真实发生，
请在临时目录中跑），但**完全不需要 API key**，且输出是确定性的——同一份
transcript 永远产出同样的 provider 输出。

```ts
// CI 中无密钥跑端到端 agent 循环测试
const result = await run({
  cwd: tmpDir,
  prompt: "随便什么 prompt",          // prompt 内容不影响回放
  replay: "./fixtures/fix-lint-session.jsonl",
  noConfigFiles: true,
  config: { provider: "replay" },
});
assert(result.text.includes("fixed"));
```

录制 transcript：用真实 key 跑一次会话，session 的 JSONL 持久化文件即为
可回放的 transcript。transcript 耗尽后 provider 会输出
`"(replay transcript exhausted)"` 作为收尾文本。

## 示例

### CI 流水线集成（PR 审查）

```ts
// scripts/review-pr.ts —— 在 CI 里跑，非零退出码阻断合并
import { run } from "@codepilot/sdk";

const diff = await exec("git diff origin/main...HEAD");

const result = await run({
  cwd: process.cwd(),
  model: "claude-sonnet-4-5",
  prompt: `审查以下 diff，只报告 bug 和安全问题，忽略风格。没有问题就回答 LGTM。\n\n${diff}`,
});

console.log(result.text);
if (!result.text.includes("LGTM") || result.hadErrors) process.exit(1);
```

### PR review bot（带自定义权限）

```ts
import { Agent } from "@codepilot/sdk";

const agent = await Agent.create({
  cwd: checkoutDir,
  onPermissionRequest: async (req) => {
    // bot 只允许只读工具 + git 查询
    if (["read_file", "ls", "glob", "grep"].includes(req.toolName)) return "allow";
    if (req.toolName === "bash" && /^git (status|diff|log)/.test(String(req.input?.command ?? ""))) return "allow";
    return "deny";
  },
});

const review = await agent.prompt(`给 PR #${prNumber} 写评审意见`);
await postComment(prNumber, review.text);
await agent.dispose();
```

### 代码质量检查器（流式进度）

```ts
import { Agent } from "@codepilot/sdk";

const agent = await Agent.create({ cwd: "." });
let tools = 0;

for await (const e of agent.stream("检查 src/ 的类型错误和未使用导出")) {
  if (e.type === "tool_call") console.error(`[${++tools}] ${e.name}`);
  if (e.type === "text") process.stdout.write(e.text);
  if (e.type === "error" && !e.recoverable) throw new Error(e.message);
}
await agent.dispose();
```

### 批量处理（一个 agent 串行处理多个任务）

```ts
import { Agent } from "@codepilot/sdk";

const agent = await Agent.create({ cwd: "." });
try {
  for (const dir of outdatedPackages) {
    const r = await agent.prompt(`把 ${dir} 的依赖升级到最新 minor 版本并跑测试`);
    report.push({ dir, ok: !r.hadErrors, cost: r.usage.costUSD });
  }
} finally {
  await agent.dispose();
}
```

## 错误处理

**disposed agent 错误** —— `dispose()` 之后再调用 `prompt()` / `stream()`
会同步抛出 `Error("agent disposed")`：

```ts
await agent.dispose();
await agent.prompt("..."); // throws: agent disposed
```

**session 错误** —— `prompt()` 本身抛异常（API 不可达、致命错误）会向上传播，
请用 try/catch 兜住；循环中途的**可恢复**错误不会抛出，而是体现在
`result.hadErrors === true` 或 stream 的 `{ type: "error", recoverable: true }`
事件里：

```ts
try {
  const result = await agent.prompt("...");
  if (result.hadErrors) {
    // 可恢复错误已发生但循环跑完了——视业务决定是否当作失败
  }
} catch (err) {
  // prompt() 本身失败（网络、认证、provider 致命错误）
}
```

`Agent.create()` 失败（配置校验不通过、transcript 加载异常等）同样直接抛异常，
此时不会有 Agent 实例需要回收。

## 最佳实践

- **始终 dispose。** 用 `try/finally` 或直接选 `run()`（内部自带 finally）。
  未 dispose 的 session 会挂住 MCP 子进程和文件句柄。
- **需要进度就用 `stream()`。** `prompt()` 只在结束时给结果；CI 日志、
  实时 UI、长任务心跳都应该走 stream 事件。
- **测试用 replay。** 录制一次真实会话的 transcript，之后在 CI 里无密钥、
  确定性地回放；配 `noConfigFiles: true` + 显式 `config` 隔离环境差异。
- **保存 `sessionId` 以恢复会话。** `agent.id` 持久化后可跨进程续聊，
  避免重复消耗上下文。
- **CI 中保留 yolo 默认 + deny 规则兜底。** 不要为 CI 写自定义权限处理器，
  用配置文件的 `permissions.deny` 限制危险操作即可。
- **多任务复用同一 agent。** 串行 `prompt()` 共享上下文且省去重复初始化；
  互相独立的任务才开多个 agent。
