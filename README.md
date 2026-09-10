# CodePilot v2

> Token 高效、支持长程任务的现代编程 Agent —— 核心引擎 + TUI + VSCode 插件 + IDEA 插件。

v2 为完全重写（v1 见 `main` 分支），架构参考 claude-code / codex 等业界最佳实践：**一切智能在 headless core，所有前端均为协议客户端**。

## 特性

- 🧠 **统一 Agent 核心** (`@codepilot/core`)：工具系统、agent loop、上下文分层压缩、子代理隔离、事件溯源会话、持久记忆、权限体系、MCP 客户端
- 💰 **Token 高效**：prompt cache 友好的分层系统提示、大工具结果 artifact 化按需取回、自动压缩、diff 编辑而非全文重写、探索任务子代理隔离
- ⏳ **长程任务**：`goal` 模式循环执行直到完成、plan 工具永不被压缩、会话可中断恢复/fork
- 🔌 **多端**：TUI（Ink）、VSCode 扩展、IDEA 插件（均经 JSON-RPC 协议连接 core）
- 🤖 **多模型**：Anthropic Claude（含 prompt caching）、OpenAI 兼容接口（DeepSeek/通义/vLLM/Ollama…）、GitHub Copilot
- 🧩 **MCP**：stdio / SSE / Streamable HTTP 三种传输，server 工具与资源自动注入
- 🔒 **沙箱 + 权限**：Seatbelt / bubblewrap / WSL 进程级隔离 + 工具层路径守卫（含符号链接逃逸防护），claude-code 风格 `allow/ask/deny` 规则，"始终允许"收窄为单条规则
- 🪝 **Hooks**：`PreToolUse` / `PostToolUse` / `Notification` / `Stop` 生命周期钩子（exit 2 可阻断工具调用）
- 🤔 **交互式提问**：`ask_user_question` 多问题结构化提问，`plan_done` 计划审批后自动切换到 agent 模式
- 🔁 **Provider failover**：限流/故障时按 `fallbacks` 顺序自动切换；后台 `bash` 任务可查询输出/终止
- 🛡️ **结果脱敏**：工具输出在回显与持久化前统一脱敏（私钥、AWS/GitHub/OpenAI/Anthropic token、连接串密码等）

## 快速开始

```bash
corepack pnpm install
corepack pnpm build

# 配置密钥（任一）
export ANTHROPIC_API_KEY=...   # 或 OPENAI_API_KEY / GITHUB_TOKEN

# 一次性执行（类似 claude -p / codex exec）
codepilot run "给 src/auth.ts 加上输入校验并补单测"

# 长程目标模式
codepilot goal "把本仓库的回调风格 API 全部迁移为 async/await" --max-rounds 50

# 交互式 TUI
codepilot-tui

# headless 协议服务（IDE 插件连接此进程）
codepilot serve
```

## 仓库结构

```
packages/core       agent 核心引擎
packages/protocol   headless JSON-RPC 协议 + codepilot CLI
apps/tui            终端界面
apps/vscode         VSCode 扩展
apps/idea           IntelliJ IDEA 插件（Kotlin）
docs/               ARCHITECTURE.md / PROTOCOL.md / API.md
```

## 配置

`~/.codepilot/config.json`（用户级）+ `<repo>/.codepilot/config.json`（项目级，优先）：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "smallModel": "claude-haiku-4-5",
  "permissionMode": "ask",
  "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
  "autoApprove": ["read_file", "glob", "grep", "^git (status|diff|log)"]
}
```

项目记忆写在仓库根的 `CODEPILOT.md`，会自动注入系统提示。

## 协作模式（Agent Mode）

类似 Cursor 的 Ask/Plan/Agent，所有端共用：

| 模式 | 行为 |
|---|---|
| `chat` | 只问答：禁用写文件/bash，直接给建议与代码片段 |
| `plan` | 计划模式：只读探索 + 产出实施计划，不做任何修改 |
| `agent` | 完整自主执行（默认）：全部工具 + 按权限模式审批 |

切换方式：TUI 里 `/agent <chat|plan|agent>` 或启动加 `--mode`；VSCode 侧边栏分段控件或 `CodePilot: Switch Mode`；IDEA 面板顶部控件或设置页默认值。协议方法 `session/setMode`。

## 内置工具

| 工具 | 说明 |
|---|---|
| `bash` / `bash_output` / `bash_kill` | 执行 shell 命令（沙箱隔离），支持 `run_in_background` 后台任务并查询/终止 |
| `read_file` / `write_file` / `edit_file` | 带行号读取（二进制/超长行保护、大结果 artifact 化）、写入、事务性多处编辑 |
| `glob` / `grep` / `ls` | 文件发现与内容搜索 |
| `plan_update` | 维护永不被压缩的任务计划 |
| `ask_user_question` / `plan_done` | 结构化提问（编号选项/多选/自由文本）与计划审批 |
| `task` | 并行 fan-out 子任务（explore/worker 子代理） |
| `web_fetch` / `web_search` | 抓取网页、DuckDuckGo 搜索 |
| `memory_write` / `read_artifact` | 写入持久记忆、按需取回 artifact 内容 |

## 打包

```bash
corepack pnpm package:vscode   # → apps/vscode/codepilot-vscode-*.vsix
corepack pnpm package:idea     # → apps/idea/build/distributions/codepilot-idea-*.zip
corepack pnpm package:npm      # → core/protocol/tui 的 npm tarball（codepilot CLI 在 protocol 包）
corepack pnpm package:all      # 全部
```

安装：VSCode `code --install-extension apps/vscode/codepilot-vscode-*.vsix`；IDEA `Settings → Plugins → ⚙ → Install Plugin from Disk`。

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [Headless 协议](docs/PROTOCOL.md)
- [Core API 契约](docs/API.md)
- [提示词一览（所有 prompt 的位置与修改指引）](docs/PROMPTS.md)
