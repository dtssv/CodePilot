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
| `workspace/list` | `{ path? }` | `{ path, entries: [{name, path, kind, size?}] }` |
| `workspace/read` | `{ path }` | `{ path, content, size, hash, truncated }`（单文件最多 512 KiB） |
| `workspace/write` | `{ path, content, expectedSize?, expectedHash? }` | `{ path, size, hash }`（cwd 内原子写入） |
| `workspace/search` | `{ query, path?, maxResults? }` | `{ matches: [{path, line, text}], truncated }` |
| `workspace/stat` | `{ path }` | `{ path, exists, size, hash, modifiedAt? }` |
| `workspace/watch` | `{ path? }` | `{ watching, path }`；随后推送 `workspace/changed` |
| `workspace/git-status` | `{}` | `{ branch, files: [{path, index, worktree, status}] }` |
| `workspace/git-diff` | `{ path?, staged? }` | `{ path?, diff, truncated }`（最多 512 KiB） |
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
| `workspace/changed` | `{ path, kinds: ["rename"|"change"], error? }` — `workspace/watch` 的防抖文件系统通知 |

## 流式

assistant 消息以增量事件流式下发：
`{type:"message_delta", messageId, delta:{type:"text", text}}` /
`{type:"message_delta", delta:{type:"tool_input_json", partialJson}}`。
结束于完整 `message` 事件。客户端只渲染增量、以完整事件为准持久化。

## 辅助事件：`team_message`

`task` 工具的 team 模式（见 [TEAMS.md](./TEAMS.md)）会在编排过程中下发
`{type:"team_message", from, to, content, timestamp, kind?}`，kind 取
`assignment | conclusion | conflict | summary | status`。它们和其他事件走同一个
`event` 通知，**但不属于模型上下文**（服务端不会把它们发给 provider）。客户端
可以把它们渲染成一条团队日志，也可以整段忽略——忽略不会影响会话语义。

## 传输层：stdio 与 WebSocket

协议本身与传输无关，目前有两种承载方式：

| | stdio（默认） | WebSocket |
|---|---|---|
| 启动 | `codepilot serve` | `codepilot serve --web [--port N]` |
| 帧 | NDJSON，一行一条消息 | 一个 WS message 一条消息（收端仍按换行切分，容忍客户端批量发送） |
| 客户端 | TUI / VSCode / IDEA（子进程） | 浏览器、跨进程工具 |
| 会话归属 | 一个进程一个 peer | **一个连接一个 peer**，各自独立的会话表 |
| 编程接口 | `StdioTransport` | `@codepilot/protocol/ws` 的 `startWebSocketServer()` / `WebSocketTransport` |

WebSocket 服务端刻意放在 `@codepilot/protocol/ws` 子路径而不是主入口：它会引入
`ws` 依赖，而打包分发的消费者（VSCode 扩展）只用 stdio。

**连接即会话边界**：每个 WS 连接有自己的 `Peer` + 会话表，两个浏览器标签页是两个
互不可见的客户端（A 的 sessionId 在 B 上会得到 `SessionNotFound`）。掉线不是灾难
——会话转录是持久化的，重连后用 `session/resume` 恢复。

**掉线清理**：浏览器标签页可能不发 close 帧就消失，所以连接断开时会走
`ServerHandle.dispose()`（注销事件订阅、dispose 会话、把悬空的 permission/question
请求按 fail-closed 处理），不依赖客户端老实调用 `shutdown`。另有 30s 心跳
（ping/pong），半开连接会被 terminate，否则它会一直占着会话不放。

### 安全（务必读完）

这个端口前面站着一个**能执行 shell 命令**的 agent。任何能完成握手的东西都能以你的
身份运行代码，所以默认值是收紧的：

- **只绑 `127.0.0.1`**，除非显式 `--host`。
- **必须带 token**：不传 `--token` 就随机生成一个并在启动时打印；客户端用
  `?token=<t>`（浏览器只能用这个，WS 握手不能自定义 header）或
  `Authorization: Bearer <t>`。比较是常量时间的。
- **Origin 白名单**：WS 升级**不受 CORS 约束**，任何网页都能连你的 localhost。
  没有 Origin 检查的话，用户访问的任意页面就能驱动他的 agent。规则是：**不带
  Origin 的请求放过**（非浏览器客户端本来就不带，拦它只会拦死 TUI/curl）；
  带 Origin 的必须在白名单里（默认只有同端口的 localhost，其他用
  `--allow-origin` 加）。
- 拒绝发生在 HTTP 升级阶段并带真实状态码（401 token 不对 / 403 origin 不允许 /
  503 连接数超限），而不是一个没有信息的 socket close。**Origin 先判、token 后判**，
  免得恶意页面拿这个端点去探 token 是否正确。
- `--no-auth` 只给测试和可信网络用；配合非 loopback 的 `--host` 时 CLI 会直接拒绝
  启动而不是打个警告。

## 错误

标准 JSON-RPC error；agent 内部错误以 `{type:"error", message, recoverable}` 事件下发。

## 版本协商

`initialize` 中 protocolVersion 不一致时服务端返回 `-32602` 错误并附带支持版本列表。
