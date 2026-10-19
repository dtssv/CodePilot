# CodePilot

Token 高效、支持长程任务的编程 Agent：核心引擎 + CLI/TUI + Agent 桌面端 + Web 端 + VSCode / IDEA 插件。各端共用同一套界面语言与协议。

**架构要点**：智能与工具执行集中在 headless core（`@codepilot/core`）；CLI、TUI、Web、桌面与 IDE 插件均为协议客户端，通过 JSON-RPC（stdio 或 WebSocket）驱动同一会话。

## 特性

- **统一 Agent 核心**：工具系统、agent loop、上下文分层压缩、子代理隔离、事件溯源会话、持久记忆、权限体系、MCP 客户端
- **Token 高效**：分层系统提示（静态前缀可缓存 + 动态后缀每轮刷新）、大工具结果 artifact 化按需取回、自动压缩、diff 编辑、探索任务子代理隔离
- **长程任务**：`goal` 模式循环直到完成、plan 不被压缩、会话可中断恢复 / fork
- **多端一致**：CLI/TUI、Agent 桌面端、Web、VSCode / IDEA；图形端共用 `apps/web` React 界面，按布局切换
- **流式重试**：中断后按 `turnRetries` 整轮重试，半截输出撤回，界面只显示重试提示
- **多模型**：Anthropic（含 prompt caching）、OpenAI 兼容接口、GitHub Copilot
- **MCP**：stdio / SSE / Streamable HTTP
- **沙箱 + 权限**：Seatbelt / bubblewrap / WSL 进程隔离 + 路径守卫；`allow` / `ask` / `deny` 规则；「始终允许」收窄为单条规则
- **Hooks**：`PreToolUse` / `PostToolUse` / `Notification` / `Stop`（exit 2 可阻断工具）
- **交互提问**：`ask_user_question` 结构化提问，`plan_done` 计划审批后切到 agent 模式
- **Failover 与后台任务**：`fallbacks` 切换模型；后台 `bash` 可查询 / 终止
- **结果脱敏**：回显与持久化前统一脱敏敏感串

## 快速开始

```bash
corepack pnpm install
corepack pnpm build

export ANTHROPIC_API_KEY=...   # 或 OPENAI_API_KEY / GITHUB_TOKEN

# 一次性执行
codepilot run "给 src/auth.ts 加上输入校验并补单测"

# 长程目标
codepilot goal "把本仓库的回调风格 API 全部迁移为 async/await" --max-rounds 50

# 交互式 TUI
codepilot-tui

# Agent：任务式界面（浏览器应用窗；关窗即退出）
codepilot agent ~/my-project

# Agent 桌面端（Electron）
corepack pnpm desktop

# Web：同端口托管协议 + SPA，默认打开浏览器（带 token）
codepilot serve --web --web-root

# headless 协议（IDE 插件连接此进程）
codepilot serve
```

## 仓库结构

```
packages/core       agent 核心引擎
packages/protocol   headless JSON-RPC + codepilot CLI
apps/tui            终端界面（Ink）
apps/web            共享图形界面（Web / Agent / IDE 内嵌布局）
apps/desktop        Electron 外壳（Agent 布局）
apps/vscode         VSCode 扩展
apps/idea           IntelliJ 插件（Kotlin / JCEF）
scripts/package     各端可执行产物打包脚本
```

## 多端

| 端 | 入口 | 界面 |
|---|---|---|
| CLI / TUI | `codepilot run`、`codepilot-tui` | 终端；配色与图标对齐图形端 |
| Agent | `codepilot agent [dir]`、`apps/desktop` | 任务式：模板 → 进度 / 动态 / 产出 |
| Web | `codepilot serve --web --web-root` 或打包的 `codepilot-web-*` | 会话列表 + 转录 + 工作区 |
| 插件 | VSCode 侧边栏、IDEA 工具窗 | 紧凑布局，跟随 IDE 主题 |

图形端同一份代码，布局由宿主或 `?layout=web|agent|embedded` 决定。IDE 插件启动本地 `codepilot serve`，经宿主桥收发 JSON-RPC，不依赖独立 WebSocket 服务。

## 配置

`~/.codepilot/config.json`（用户）+ `<repo>/.codepilot/config.json`（项目，优先）：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "smallModel": "claude-haiku-4-5",
  "permissionMode": "ask",
  "providers": {
    "deepseek": {
      "provider": "openai",
      "displayName": "DeepSeek",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  },
  "autoApprove": ["read_file", "glob", "grep", "^git (status|diff|log)"]
}
```

可用 `providers` 保存多厂商预设；Web/Agent 设置、`codepilot config`、REPL/TUI 的 `/model` `/provider` 均可切换。项目记忆写在仓库根 `CODEPILOT.md`。`turnRetries`（0–10，默认 2）控制流式中断后的整轮重试次数。

## 协作模式

所有端共用三种模式（协议方法 `session/setMode`）：

| 模式 | 行为 |
|---|---|
| `chat` | 只问答：禁用写文件 / bash |
| `plan` | 只读探索 + 产出计划，不改仓库 |
| `agent` | 自主执行（默认）：全工具 + 权限审批 |

图形端输入框下切换「问答 / 计划 / 智能体」；TUI 用 `/agent <chat|plan|agent>` 或 `--mode`。

## 内置工具（节选）

| 工具 | 说明 |
|---|---|
| `bash` / `bash_output` / `bash_kill` | 沙箱 shell；支持后台任务 |
| `read_file` / `write_file` / `edit_file` | 读 / 写 / 事务性多处编辑 |
| `glob` / `grep` / `ls` | 发现与搜索 |
| `plan_update` / `ask_user_question` / `plan_done` | 计划与结构化提问 |
| `task` | 并行子代理 |
| `web_fetch` / `web_search` | 网页与搜索 |
| `memory_write` / `read_artifact` | 记忆与 artifact 取回 |

## 打包

```bash
corepack pnpm package:cli
corepack pnpm package:tui
corepack pnpm package:web      # codepilot-web-* 可执行程序（启动服务并打开浏览器）
corepack pnpm package:desktop
corepack pnpm package:vscode
corepack pnpm package:idea
corepack pnpm package:all
```
