# Headless / Print Mode（CI 脚本集成）

> 参考 claude-code 的 `claude -p --output-format json` 机制：CodePilot TUI
> 支持非交互的 "print" 模式——跳过 Ink UI，跑完一条 prompt 后直接把
> 机器可读的结果写到 stdout 并退出。专为 CI / 脚本 / agent 链接设计。

## 快速上手

```bash
# 纯文本输出（默认）——只打印最终助手消息
codepilot-tui -p "总结当前 git diff"

# 单个 JSON 结果对象（跑完后一次性输出）
codepilot-tui -p --output-format json "审查这次改动"

# NDJSON 流——每行一个事件，实时输出
codepilot-tui -p --output-format stream-json "跑一遍测试并报告"

# 从 stdin 管道喂 prompt
echo "解释这个函数" | codepilot-tui -p --output-format json
git diff HEAD | codepilot-tui -p --output-format json "这次改动有什么要注意的？"
```

## 命令行参数

| 参数 | 说明 |
|---|---|
| `-p`、`--print` | 进入 headless 模式。必须配一个 prompt（位置参数或 stdin）。 |
| `--output-format <fmt>` | 输出格式：`text`（默认）｜`json`｜`stream-json`。仅在 `--print` 下生效。 |
| `--yolo` | 建议搭配使用：headless 没有交互 UI 来批准工具调用，`--yolo` 自动放行；否则需要审批的工具调用会被拒绝。 |
| `--cwd <dir>` | 项目目录（默认 `$PWD`）。 |
| `--model <name>` | 覆盖模型。 |
| `--mode <chat\|plan\|agent>` | 协作模式（默认 `agent`）。 |
| `--resume <id>` | 恢复已有会话。 |

## 三种输出格式

### `text`（默认）

只输出最终助手消息的纯文本，末尾一个换行。适合简单查询和人类阅读。

```bash
$ codepilot-tui -p "用一句话解释什么是闭包"
闭包是一个函数连同它创建时捕获的外层变量引用的统称——即使外层函数已返回，闭包仍能访问那些变量。
```

### `json`

跑完后输出**单个** JSON 对象（一行），包含完整结果与元数据。等整轮结束才输出，
适合需要一次性拿到结构化结果的 CI 步骤。schema 刻意对齐 claude-code：

```jsonc
{
  "type": "result",
  "subtype": "success",            // "success" | "error"
  "result": "Review content...",   // 最终助手文本（error 时是错误信息）
  "session_id": "sess_abc123",     // 可用于 --resume
  "usage": { "input": 1234, "output": 567, "costUSD": 0.0045 },
  "cost_usd": 0.0045,              // 等同 usage.costUSD，便于 jq 取值
  "duration_ms": 2341,
  "num_turns": 3,                  // 助手消息轮数
  "had_tool_calls": true,          // 本轮是否调用过工具
  "errors": []                     // 中途的 recoverable 错误（不改变 subtype）
}
```

`jq` 取最终文本：`codepilot-tui -p --output-format json "..." | jq -r .result`

`subtype` 的判定：
- `success`：`prompt()` 正常返回（即使中途有 recoverable 的 `error` 事件，
  它们会被收进 `errors[]` 但不翻转 subtype）。
- `error`：`prompt()` 本身抛异常（API 不可达、致命错误等）。

### `stream-json`

实时输出 **NDJSON**（每行一个 JSON 对象）。每个核心 `Event` 一行，最后再补一个
`type: "result"` 的收尾行。适合需要实时进度或把多个 agent 串起来的场景。

```
{"type":"message","id":"msg_...","role":"user","content":[{"type":"text","text":"..."}]}
{"type":"message","id":"msg_...","role":"assistant","content":[{"type":"text","text":"let me check"}]}
{"type":"tool_call","id":"tc_...","name":"read_file","input":{"path":"..."}}
{"type":"tool_result","toolCallId":"tc_...","name":"read_file","content":"..."}
{"type":"message","id":"msg_...","role":"assistant","content":[{"type":"text","text":"done"}]}
{"type":"result","subtype":"success","result":"done","session_id":"...","usage":{...},"duration_ms":1234,"num_turns":2,"had_tool_calls":true,"errors":[]}
```

逐行消费：

```bash
codepilot-tui -p --output-format stream-json "跑测试" | while IFS= read -r line; do
  echo "$line" | jq -r '.type'
done
```

## 权限与安全

headless 模式**没有交互 UI** 来响应权限请求或 `ask_user` 问题。行为：

- **未配置权限处理器**：session 的 `onPermissionRequest` / `onAskUser` 为空。
- 因此 `permissionMode` 决定了工具调用的命运：
  - `yolo`：所有工具调用自动放行（CI 常用，但请只授予必要的工具）。
  - `ask` / `auto-edit`：需要审批的工具调用（写文件、bash 等）会被**拒绝**，
    工具结果变成 `permission denied`，模型会看到并自行处理。
- 建议在 CI 里用 `--yolo` 并配合项目级 `permissions.deny` 规则做兜底防护，
  例如在 `.codepilot/config.json` 里：

  ```json
  { "permissionMode": "yolo", "permissions": { "deny": ["bash(rm -rf *)", "bash(git push *)"] } }
  ```

## 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 正常完成（`subtype: success`）。 |
| 1 | `prompt()` 抛异常（`subtype: error`）。 |
| 2 | 参数错误（缺 prompt、`--output-format` 非法、`--cwd` 不存在等）。 |

## API

```ts
// apps/tui/src/headless.ts
export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessResult {
  type: "result";
  subtype: "success" | "error";
  result: string;
  session_id: string;
  usage: UsageInfo;
  cost_usd?: number;
  duration_ms: number;
  num_turns: number;
  had_tool_calls: boolean;
  errors: string[];
}

export function parseOutputFormat(raw: string | undefined): OutputFormat;
export async function runHeadless(opts: {
  session: Session;
  prompt: string;
  format: OutputFormat;
}): Promise<void>;
```

`runHeadless` 订阅 session 的事件流，在 `stream-json` 下逐事件写 NDJSON，
在 `json`/`text` 下等 `prompt()` 完成后写一次结果。调用方负责在之后 `session.dispose()`。

## 设计取舍

- **对齐 claude-code 的 result schema**：`type`/`subtype`/`result`/`session_id`/
  `usage`/`cost_usd`/`duration_ms`/`num_turns` 字段名与 claude-code 一致，
  写过 `claude -p --output-format json | jq .result` 的脚本可以零改迁移。
- **不自动加 `--verbose`**：claude-code 要求 `stream-json` 必须配 `--verbose`，
  我们不需要——CodePilot 的事件流本身就是结构化的，没有"精简模式"需要切换。
- **recoverable 错误不翻转 subtype**：agent 循环中途的 `error` 事件（流断流、
  工具异常等）被收进 `errors[]`，只要 `prompt()` 正常返回就是 `success`；
  只有 `prompt()` 抛异常才是 `error`。这避免了 CI 因为一个可恢复的流抖动而误判失败。
- **stdin fallback**：没有位置参数时从 stdin 读 prompt，支持
  `echo "..." | codepilot-tui -p` 和 `git diff | codepilot-tui -p "..."` 两种惯用法。
