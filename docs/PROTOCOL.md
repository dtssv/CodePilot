# CodePilot Headless Protocol v1

JSON-RPC 2.0 over stdio（换行分隔 JSON，NDJSON）。客户端 = 前端（TUI 内嵌、VSCode、IDEA），服务端 = `@codepilot/core` 以 `codepilot serve` 启动的进程。

## 生命周期

1. 客户端 spawn `codepilot serve`（或连接已有实例）。
2. `initialize` 握手：交换协议版本、能力、工作目录、权限模式。
3. 之后可开多个 session：`session/new`、`session/resume`。
4. 关闭：`shutdown` + `exit`。

## 客户端 → 服务端 方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `initialize` | `{ protocolVersion: 1, cwd, permissionMode: "ask"\|"auto-edit"\|"yolo", clientInfo: {name, version} }` | `{ protocolVersion, capabilities: { tools: string[], providers: string[], modes: ["chat","plan","agent"] } }` |
| `session/new` | `{ cwd?, model?, systemPromptExtra?, agentMode?: "chat"\|"plan"\|"agent" }` | `{ sessionId }` |
| `session/resume` | `{ sessionId }` | `{ sessionId, events: Event[] }`（重放事件） |
| `session/setMode` | `{ sessionId, mode: "chat"\|"plan"\|"agent" }` | `{}`（运行时切换协作模式；服务端立即发出 `{type:"mode", mode}` 事件） |
| `session/list` | `{}` | `{ sessions: [{id, title, updatedAt, cwd}] }` |
| `prompt/send` | `{ sessionId, text, images?: [{mediaType, base64}] }` | `{}`（响应经通知流式推送） |
| `prompt/cancel` | `{ sessionId }` | `{}` |
| `permission/respond` | `{ requestId, decision: "allow"\|"deny"\|"always" }` | `{}` |
| `question/respond` | `{ requestId, answers: { [questionId]: string \| string[] } }` | `{}` |
| `session/fork` | `{ sessionId, atEventIndex? }` | `{ sessionId }` |
| `shutdown` | `{}` | `{}` |

## 协作模式（Cursor-style）

`session/new` 与 `session/setMode` 接受 `mode` 字段（取值 `"chat" | "plan" | "agent"`）。
默认 `"agent"`。

- **`chat`（只读问答）**：仅暴露只读工具（`read_file` / `glob` / `grep` / `ls` /
  `read_artifact` / `web_fetch`），系统提示追加"当前为问答模式，不要修改文件，
  直接给出建议与代码片段"。`bash` / `write_file` / `edit_file` / `task` /
  `plan_update` / `memory_write` 全部禁用。
- **`plan`（只读探索 + 计划）**：在 `chat` 基础上额外放开 `plan_update` 与
  `memory_write`，便于在规划阶段沉淀发现。`bash` / `write_file` / `edit_file` /
  `task` 仍禁用；系统提示追加"探索代码并产出实施计划，不要做任何修改"。
- **`agent`（完整自主）**：所有内置工具 + 已注册的 MCP 工具全部可用（默认）。

切换模式后服务端会立即发送 `{type:"mode", mode}` 事件作为通知
（`event` 通知的 payload.event），下一轮 `prompt/send` 时使用的工具表与系统提示
都会反映新模式。`session/setMode` 在未知会话或非法 mode 时返回
`SessionNotFound` / `InvalidParams`。

## 服务端 → 客户端 通知

| 通知 | 参数 |
|---|---|
| `event` | `{ sessionId, event: Event }` — 所有会话事件（含流式 text_delta/tool_use 增量） |
| `permission/request` | 这是一个**请求**（非通知）：`{ sessionId, requestId, toolName, input, reason }`，客户端用 `permission/respond` 回复 |
| `question/request` | 这是一个**请求**（非通知）：`{ sessionId, requestId, questions: [{ id, header?, question, options?: [{label, description?}], multiSelect? }] }`，客户端用 `question/respond` 回复（answers 以 question id 为键，值为选项 label、label 数组或自由文本）。由 `ask_user_question` / `plan_done` 工具触发；客户端不可达或服务端 shutdown 时按空 answers 失败关闭（plan_done 视为未批准） |
| `session/usage` | `{ sessionId, usage: {input, output, cacheRead, cacheWrite, costUSD} }` |

## 流式

assistant 消息以增量事件流式下发：
`{type:"message_delta", messageId, delta:{type:"text", text}}` /
`{type:"message_delta", delta:{type:"tool_input_json", partialJson}}`。
结束于完整 `message` 事件。客户端只渲染增量、以完整事件为准持久化。

## 错误

标准 JSON-RPC error；agent 内部错误以 `{type:"error", message, recoverable}` 事件下发。

## 版本协商

`initialize` 中 protocolVersion 不一致时服务端返回 `-32602` 错误并附带支持版本列表。
