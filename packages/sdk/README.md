# @codepilot/sdk

Programmatic, in-process SDK for embedding the CodePilot agent. Wraps the
headless core (`@codepilot/core`) with a small, ergonomic surface: create an
agent, send prompts (await the result or stream events), and clean up.

## Install

```bash
npm install @codepilot/sdk
```

## Quick start

```ts
import { Agent, run } from "@codepilot/sdk";

// One-shot: create, prompt, dispose — returns the final result.
const result = await run({ cwd: process.cwd(), prompt: "Summarize README.md" });
console.log(result.text, result.usage, result.sessionId);

// Long-lived agent with streaming.
const agent = await Agent.create({ cwd: process.cwd() });
for await (const ev of agent.stream("List the open TODOs")) {
  if (ev.type === "text") process.stdout.write(ev.text);
}
await agent.dispose();
```

## Options

`Agent.create(opts)` and `run(opts)` accept:

| Option | Type | Meaning |
|---|---|---|
| `cwd` | `string` | Working directory (default `process.cwd()`). |
| `model` | `string` | Model id override. |
| `config` | `Partial<CodepilotConfig>` | Config overrides merged over loaded config. |
| `sessionId` | `string` | Resume an existing session. |
| `agentMode` | `"chat"\|"plan"\|"agent"` | Collaboration mode (default `agent`). |
| `permissionMode` | `PermissionMode` | First-class shortcut for `config.permissionMode` (wins over it). Controls auto-approve/deny when no `onPermissionRequest` is given. |
| `maxTurns` | `number` | First-class shortcut for `config.maxTurns` (wins over it). `0`/undefined = no limit. |
| `allowedTools` | `string[]` | Restrict the tool surface the model sees. |
| `signal` | `AbortSignal` | Aborting it cancels the in-flight run (same as `agent.cancel()`). |
| `onPermissionRequest` | handler | Approve/deny tool calls. Unset = auto-approve (CI). |
| `onAskUser` | handler | Answer `ask_user_question` / `plan_done`. |
| `noConfigFiles` | `boolean` | Skip loading config files. |
| `replay` | `string` | Path to a transcript JSONL for keyless testing. |

`run(opts)` additionally takes `prompt: string` and optional `images`.

## Cancellation

```ts
const agent = await Agent.create({ cwd });
const p = agent.prompt("long task…");
agent.cancel();           // or pass an AbortSignal to create()
await p;
```

## Result shape

```ts
interface AgentResult {
  text: string;
  hadErrors: boolean;
  toolCallCount: number;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUSD?: number };
  sessionId: string;
}
```
