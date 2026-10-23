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
- 项目说明：仓库根 `CODEPILOT.md`

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

常用：`/mode chat|plan|agent`、`/model`、`/provider`、`/clear`、`/exit`。  
Ctrl+C：忙时取消当前轮，空闲时退出。

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

图形端切换「问答 / 计划 / 智能体」；命令行 `--mode`；TUI `/mode`。

### VS Code / IntelliJ

- VS Code：`codepilot-vscode-*.vsix` → 「从 VSIX 安装…」
- IntelliJ：`codepilot-idea-*.zip` → 「从磁盘安装」

```bash
corepack pnpm package:vscode
corepack pnpm package:idea   # 需 JDK 17
```

---

源码：https://github.com/dtssv/CodePilot  
