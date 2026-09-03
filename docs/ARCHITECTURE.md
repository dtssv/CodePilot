# CodePilot v2 架构设计

> 参考 claude-code / codex / workbuddy 的现代编程 agent 最佳实践，完全重构。

## 总览

```
┌──────────┐  ┌───────────┐  ┌─────────────┐
│   TUI    │  │  VSCode   │  │ IDEA Plugin │
│ (apps/)  │  │ (apps/)   │  │  (apps/)    │
└────┬─────┘  └─────┬─────┘  └──────┬──────┘
     │ stdio/JSON-RPC (packages/protocol)
     ▼              ▼               ▼
┌──────────────────────────────────────────┐
│         @codepilot/core (headless)        │
│  Agent Loop │ Providers │ Tools │ Memory │
│  Compaction │ Subagents │ Perms │  MCP   │
└──────────────────────────────────────────┘
```

**核心原则**：一切智能在 core；所有前端（TUI/VSCode/IDEA）只是 protocol 的客户端。
core 也可作为 CLI 直接运行（`codepilot run "task"`，类似 codex exec / claude -p）。

## Monorepo 结构（pnpm workspaces + TypeScript NodeNext ESM）

| 包 | 职责 |
|---|---|
| `packages/core` | agent 引擎：provider 抽象、工具系统、agent loop、上下文压缩、子代理、会话持久化、记忆、权限、MCP 客户端、长程任务目标循环 |
| `packages/protocol` | JSON-RPC 2.0 over stdio 的 headless 协议定义与 server 封装（VSCode/IDEA 插件经此连接） |
| `apps/tui` | 终端 UI（Ink/React），渲染流式输出、diff、权限确认 |
| `apps/vscode` | VSCode 扩展，spawn core 作为子进程经 protocol 通信 |
| `apps/idea` | IntelliJ 插件（Kotlin + Gradle），同样 spawn core 子进程 |
| `docs/` | 设计文档 |

## Token 效率设计（核心目标）

1. **分层系统提示**：静态部分前置保证 prompt cache 命中（Claude cache_control / OpenAI 自动前缀缓存），动态内容（日期、git 状态、记忆摘要）放尾部。
2. **工具结果按需加载**：大文件读取/搜索结果被截断并写入磁盘存储，context 里只保留引用与摘要；模型可用 `read_artifact` 工具分页取回。
3. **上下文压缩（compaction）**：token 超阈值时触发分层压缩——工具输出先折叠为摘要，再对历史消息做 LLM 摘要，保留最近的"工作记忆窗口"与任务状态（plan/todo 列表永不被压缩）。
4. **子代理隔离**：探索/搜索类任务派发给子代理（独立 context），主 context 只回收结论，类似 claude-code 的 Task 工具。
5. **diff 而非全文**：编辑工具采用 search/replace 与 edit-by-diff，失败时回退正则/行号策略，避免整文件重写。

## 长程任务设计

1. **Task Plan 工具**：`plan_update` 维护结构化步骤列表（pending/in_progress/completed），压缩时始终保留。
2. **Goal Loop**：`codepilot goal "objective"` 模式——agent 循环执行直到目标完成或被阻塞，每轮可续接持久化会话，支持中断恢复（session 存 `~/.codepilot/sessions/*.jsonl`）。
3. **持久记忆**：项目级 `CODEPILOT.md` + 用户级 `~/.codepilot/MEMORY.md`，模型通过 `memory_write` 工具沉淀跨会话知识；启动时注入摘要。
4. **事件溯源会话**：会话以 JSONL 追加存储（每条消息/工具调用一条记录），可 fork、回滚、恢复。

## 权限体系

工具分级：`read`（只读，自动放行）、`write`（编辑文件，默认询问）、`execute`（bash，默认询问+命令白名单正则）、`network`（MCP/web）。
模式：`ask`（默认）/ `auto-edit` / `yolo`（全放行，沙箱内使用）。审批由前端经 protocol 的 `permission/request` 反向请求完成。

## Provider 抽象

统一 `ChatProvider` 接口：`stream(messages, tools, options) → AsyncIterable<StreamEvent>`。

- `anthropic`：Messages API，支持 prompt caching（cache_control breakpoints）。
- `openai`：OpenAI 兼容 chat.completions（覆盖 DeepSeek/通义/vLLM/Ollama 等），tool calling + streaming。
- `copilot`：GitHub Copilot API（device flow OAuth → copilot token → chat completions endpoint）。

模型路由：可配置 `smallModel`（压缩、标题生成等后台任务用便宜模型）。

## MCP

core 实现 MCP client（stdio transport，可扩展 SSE），配置于 `~/.codepilot/config.json` 的 `mcpServers`；MCP 工具以 `mcp__<server>__<tool>` 命名注入工具表。

## 关键工具集（内置）

`bash` / `read_file` / `write_file` / `edit_file`(search-replace) / `glob` / `grep` / `ls` / `plan_update` / `memory_write` / `task`(子代理) / `read_artifact` / `web_fetch`(可选)。

## 会话/事件模型

```ts
type Event =
  | { type: "message", role: "user"|"assistant", content: ContentBlock[] }
  | { type: "tool_call", id, name, input }
  | { type: "tool_result", toolCallId, content, isError?, artifactRef? }
  | { type: "plan", steps: PlanStep[] }
  | { type: "usage", input, output, cacheRead?, cacheWrite?, cost? }
  | { type: "compaction", summary, droppedRange }
```

前端订阅事件流即可完整还原 UI；事件 JSONL 即会话持久化格式（写时一致性 = 免费恢复能力）。
