# CodePilot v2

> Token 高效、支持长程任务的现代编程 Agent —— 核心引擎 + TUI + VSCode 插件 + IDEA 插件。

v2 为完全重写（v1 见 `main` 分支），架构参考 claude-code / codex 等业界最佳实践：**一切智能在 headless core，所有前端均为协议客户端**。

## 特性

- 🧠 **统一 Agent 核心** (`@codepilot/core`)：工具系统、agent loop、上下文分层压缩、子代理隔离、事件溯源会话、持久记忆、权限体系、MCP 客户端
- 💰 **Token 高效**：prompt cache 友好的分层系统提示、大工具结果 artifact 化按需取回、自动压缩、diff 编辑而非全文重写、探索任务子代理隔离
- ⏳ **长程任务**：`goal` 模式循环执行直到完成、plan 工具永不被压缩、会话可中断恢复/fork
- 🔌 **多端**：TUI（Ink）、VSCode 扩展、IDEA 插件（均经 JSON-RPC 协议连接 core）
- 🤖 **多模型**：Anthropic Claude（含 prompt caching）、OpenAI 兼容接口（DeepSeek/通义/vLLM/Ollama…）、GitHub Copilot
- 🧩 **MCP**：stdio MCP server 工具自动注入

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

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [Headless 协议](docs/PROTOCOL.md)
- [Core API 契约](docs/API.md)
