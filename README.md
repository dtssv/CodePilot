# CodePilot

编程 Agent：命令行、终端 UI、浏览器、桌面窗，以及 VS Code / IntelliJ 插件。

---

## 安装

### 一键安装（推荐）

macOS / Linux / Windows（Git Bash 或 WSL）。需要 **Node.js ≥ 20** 与 npm：

```bash
curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash
```

指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash -s -- --version v2.1.1
```

会从 [Releases](https://github.com/dtssv/CodePilot/releases) 拉取各端共用的 npm 包，装到 `~/.codepilot`：

| 资源 | 说明 |
|---|---|
| `codepilot-core-*.tgz` | 引擎 |
| `codepilot-protocol-*.tgz` | `codepilot` CLI |
| `codepilot-tui-*.tgz` | `codepilot-tui` 终端 UI |
| `install.sh` | 本安装脚本（Release 也附带） |

装好后：

```bash
codepilot-tui
codepilot --help
```

### 从源码安装

```bash
git clone https://github.com/dtssv/CodePilot.git
cd CodePilot
corepack enable
corepack pnpm install
corepack pnpm build

alias codepilot='node '"$PWD"'/packages/protocol/dist/cli.js'
alias codepilot-tui='node '"$PWD"'/apps/tui/dist/cli.js'
# 或
corepack pnpm --filter @codepilot/protocol --filter @codepilot/tui link --global
```

模型密钥：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GITHUB_TOKEN`，或在配置里写 OpenAI 兼容网关。

IDE 插件从 [Releases](https://github.com/dtssv/CodePilot/releases) 下载：`codepilot-vscode-*.vsix`、`codepilot-idea-*.zip`。

本地打多端 TUI 二进制（可选，输出在 `dist/release/tui/`）：

```bash
corepack pnpm package:tui -- --all
# → codepilot-tui-darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / win-x64.exe
```

---

## 配置

- 用户：`~/.codepilot/config.json`
- 项目：`<repo>/.codepilot/config.json`（覆盖同名项）
- 项目说明：仓库根 `CODEPILOT.md` / `AGENTS.md`
- **渐进式项目记忆**（不进 git）：会话只注入薄索引；细节按需 `read_file`
  - `~/.codepilot/projects/<hash>/MEMORY.md` — 分节摘要
  - `~/.codepilot/memory/<hash>/MEMORY.md` — 索引子弹 + topic 路径
  - 同目录 `overview.md` / `architecture.md` / `standards.md` / `knowledge.md` / … — 全文
  - Agent 用 `memory_write`（可带 `section` / `topic`）静默写入；`autoMemoryEnabled: false` 可关

```json
{
  "providers": {
    "custom-openai": {
      "provider": "openai",
      "displayName": "Custom OpenAI-compatible",
      "baseURL": "http://127.0.0.1:3456/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "model": "your-model-id",
      "models": ["your-model-id"],
      "modelCapabilities": {
        "your-model-id": {
          "contextWindow": 200000,
          "maxOutputTokens": 32000,
          "modalities": ["text"]
        }
      }
    }
  },
  "permissionMode": "ask",
  "sandbox": {
    "mode": "workspace-write",
    "writablePaths": []
  }
}
```

| 字段 | 说明 |
|---|---|
| `providers` | 模型提供方；也可用 `codepilot config` 或界面里切换 |
| `permissionMode` | `ask` / `auto-edit` / `yolo` |
| `sandbox.mode` | `workspace-write`（默认）/ `read-only` / `off` |
| `sandbox.writablePaths` | 额外可写目录 |
| `mcpServers` | MCP 服务器 |

```bash
codepilot config show
codepilot config providers
codepilot config add …
codepilot config use …
```

---

## 使用

```bash
export OPENAI_API_KEY=...
# 或 ANTHROPIC_API_KEY / GITHUB_TOKEN
```

### 跑一次任务

```bash
codepilot run "给 src/auth.ts 加上输入校验并补单测"
codepilot run "…" --cwd ~/proj --permission-mode auto-edit
```

### 长任务

```bash
codepilot goal "把回调风格 API 迁成 async/await" --max-rounds 50
```

### 交互终端

```bash
codepilot          # 多轮 REPL
codepilot-tui      # 全屏 TUI
```

常用：`/agent chat|plan|agent`（协作模式）、`/mode ask|auto-edit|yolo`（权限模式）、`/model`、`/provider`、`/export`、`/clear`、`/exit`。  
Ctrl+C：忙时取消当前轮，空闲时退出。

导出会话（排查用）：

```bash
codepilot export                 # 最新会话 → stdout（markdown）
codepilot export <id> -o out.md
codepilot export <id> --format jsonl -o out.jsonl
# TUI 内：/export 或 /export jsonl ./trace.jsonl
```

### 自动更新（引擎 vs 插件）

```bash
codepilot update          # 立刻检查并升级引擎
codepilot update --check  # 只检查不安装
# 关闭：CODEPILOT_SKIP_UPDATE=1 或启动加 --no-update
```

Web / Agent 客户端里，对话中的文件路径与产出文件可**点击预览**（Markdown、代码、图片等），不必再开外部软件。

### 浏览器界面

```bash
codepilot serve --web --web-root
# 默认 http://127.0.0.1:18765 ，会打印访问 token
```

可选：`--port`、`--host`、`--token`、`--no-open`、`--no-auth`。

```bash
codepilot connect
codepilot connect 127.0.0.1:18765 --token <token>
```

设置面板子页：

| 页 | 说明 |
|---|---|
| 连接器 | 飞书 / 钉钉 / 企微 / Notion / GitHub 等；可跳转官方授权页后填写凭证安装 |
| MCP 市场 | 打开 mcp.so / Smithery 等开源市场链接；找到后粘贴 JSON 安装 |
| 远程 | 一次性二维码（局域网 IP，非 127.0.0.1）；手机 scoped 授权 |
| 定时 | 闲时任务（`serve` 内调度） |

连接器与模型服务商列表来自仓库 `catalog/*.json`（GitHub raw），本地在 `~/.codepilot/catalog/`：**每天最多尝试更新一次**；弱网/离线失败则**一直沿用本地**。可用 `CODEPILOT_CATALOG_BASE_URL` 覆盖源地址。

手机扫码请用局域网监听：

```bash
codepilot serve --web --web-root --host 0.0.0.0
```

TUI：`/undo` `/redo`、`/init`、`/remote`、`/schedule`。

### Agent 窗 / 桌面

```bash
codepilot agent ~/my-project
corepack pnpm desktop
```

### 模式

| 模式 | 用途 |
|---|---|
| `chat` | 只问答，不改文件、不跑 bash |
| `plan` | 只读摸清情况并出计划 |
| `agent` | 默认：可改代码、跑命令（按权限模式确认） |

图形端切换「问答 / 计划 / 智能体」；命令行 `--mode`；TUI `/agent`。

### VS Code / IntelliJ

- VS Code：`codepilot-vscode-*.vsix` → 「从 VSIX 安装…」
- IntelliJ：`codepilot-idea-*.zip` → 「从磁盘安装」

```bash
corepack pnpm package:vscode
corepack pnpm package:idea   # 需 JDK 17
```

---

源码：https://github.com/dtssv/CodePilot  
