<p align="center"><strong>CodePilot</strong> 是一个在本地运行的编程 Agent。</p>

<p align="center">
一个命令行工具，同时是全屏终端 UI、浏览器界面、桌面窗，以及 VS Code / IntelliJ 插件。
</p>

---

## 快速开始

### 安装

下载自包含的单文件二进制（内嵌运行时），**无需预装 Node.js 或 npm**。

**macOS / Linux / Windows（Git Bash 或 WSL）：**

```bash
curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash
```

**Windows（PowerShell，原生）：**

```powershell
irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1 | iex
```

脚本会从 [Releases](https://github.com/dtssv/CodePilot/releases) 拉取对应平台的 `codepilot-<平台>` 二进制，装到 `~/.codepilot/bin`（Windows 为 `%USERPROFILE%\.codepilot\bin`）并加入 PATH。

<details>
<summary>指定版本 / 旧版 Windows / 从 Release 手动下载</summary>

指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash -s -- --version v1.0.0
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1))) -Version v1.0.0
```

**Windows（旧系统 / cmd.exe）：** 从 [Releases](https://github.com/dtssv/CodePilot/releases) 下载 `install.cmd` 后运行（可选带版本号），它会转交给 PowerShell 执行：

```bat
install.cmd
install.cmd v1.0.0
```

每个 Release 附带 6 个平台二进制，命名为 `codepilot-<平台>`：
`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `win-x64.exe` / `win-arm64.exe`。TUI、命令行、浏览器界面都在这一个文件里。

</details>

### 运行

```bash
codepilot            # 全屏终端 UI
codepilot web        # 在浏览器里打开同一个会话
codepilot --help     # 所有命令
```

配一个模型密钥即可开始：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 或 `GITHUB_TOKEN`，也可以在配置里写 OpenAI 兼容网关。

---

## 使用

**全屏 TUI**——直接运行 `codepilot`。常用斜杠命令：

- `/agent chat｜plan｜agent` 切换协作模式，`/mode ask｜auto-edit｜yolo` 切换权限模式
- `/model` · `/provider` 选模型 / 服务商，`/connect` 向导式添加密钥
- `/web` 在浏览器里打开当前会话，`/remote` 生成手机扫码遥控二维码
- `/export [md｜jsonl]` 导出会话，`/init` 生成 `AGENTS.md`，`/undo` · `/redo` 撤销 / 重做改动
- `/context` · `/mcp` · `/skills` · `/agents` 查看上下文与运行时状态
- Ctrl+C：忙时取消当前轮，空闲时退出

**跑一次任务**（非交互）：

```bash
codepilot run "给 src/auth.ts 加上输入校验并补单测"
codepilot run "…" --cwd ~/proj --permission-mode auto-edit
```

**长任务循环**：

```bash
codepilot goal "把回调风格 API 迁成 async/await" --max-rounds 50
```

**浏览器界面**——`codepilot web` 开起本地服务并打开浏览器（默认 `127.0.0.1:18765`，打印访问 token）；手机扫码用 `--host 0.0.0.0`：

```bash
codepilot web --host 0.0.0.0        # 局域网可访问；可加 --port / --token / --no-open
codepilot connect 127.0.0.1:18765 --token <token>   # 终端附着到正在运行的服务
```

浏览器 / 桌面端里，对话中的文件路径和产出文件都可**点击预览**（Markdown、代码、图片等）。设置面板含：连接器（飞书 / 钉钉 / 企微 / Notion / GitHub 等）、MCP 市场、远程扫码、定时任务。

**桌面窗 / Agent 窗**：

```bash
codepilot agent ~/my-project        # 任务型 UI，开在 Chrome/Edge app 窗口
corepack pnpm desktop               # Electron 桌面端（源码运行）
```

**导出会话**（排查用）：

```bash
codepilot export                 # 最新会话 → stdout（markdown）
codepilot export <id> --format jsonl -o out.jsonl
```

**自动更新**：

```bash
codepilot update          # 立刻检查并升级
codepilot update --check  # 只检查不安装
# 关闭：CODEPILOT_SKIP_UPDATE=1 或启动加 --no-update
```

---

## 配置

- 用户：`~/.codepilot/config.json`
- 项目：`<repo>/.codepilot/config.json`（覆盖同名项）
- 项目说明：仓库根 `CODEPILOT.md` / `AGENTS.md`（作为项目记忆注入）

```json
{
  "providers": {
    "custom-openai": {
      "provider": "openai",
      "displayName": "Custom OpenAI-compatible",
      "baseURL": "http://127.0.0.1:3456/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "model": "your-model-id",
      "models": ["your-model-id"]
    }
  },
  "permissionMode": "ask",
  "sandbox": { "mode": "workspace-write", "writablePaths": [] }
}
```

| 字段 | 说明 |
|---|---|
| `providers` | 模型提供方；也可用 `codepilot config` 或界面里切换 |
| `permissionMode` | `ask` / `auto-edit` / `yolo` |
| `sandbox.mode` | `workspace-write`（默认）/ `read-only` / `off` |
| `sandbox.writablePaths` | 额外可写目录 |
| `mcpServers` | MCP 服务器 |

命令行管理配置：

```bash
codepilot config show | providers | add | use | remove | templates
```

**协作模式**（`--mode` 或 `/agent`）：

| 模式 | 用途 |
|---|---|
| `chat` | 只问答，不改文件、不跑 bash |
| `plan` | 只读摸清情况并出计划 |
| `agent` | 默认：可改代码、跑命令（按权限模式确认） |

---

## IDE 插件

从 [Releases](https://github.com/dtssv/CodePilot/releases) 下载：

- VS Code：`codepilot-vscode-*.vsix` →「从 VSIX 安装…」
- IntelliJ：`codepilot-idea-*.zip` →「从磁盘安装插件」

---

## 从源码构建

```bash
git clone https://github.com/dtssv/CodePilot.git
cd CodePilot
corepack enable
corepack pnpm install
corepack pnpm build

alias codepilot='node '"$PWD"'/apps/tui/dist/cli.js'
```

打多端产物（输出在 `dist/release/`）：

```bash
corepack pnpm package:cli -- --all   # 统一 codepilot 二进制（Bun --compile，内嵌 Web UI）
corepack pnpm package:desktop        # Electron 桌面安装包（.dmg / .exe / .AppImage）
corepack pnpm package:vscode         # VS Code 扩展（.vsix）
corepack pnpm package:idea           # IntelliJ 插件（需 JDK 17）
corepack pnpm package:all -- --all   # 全部
```

<details>
<summary>构建与跨平台说明</summary>

- 统一二进制用 Bun `--compile` 打包 TUI 入口，内嵌 Web SPA。裸 `codepilot` 进 TUI；`web` / `serve` / `run` / `goal` / `agent` / `config` / `export` / `update` / `connect` 走命令行。
- Bun 可从单一宿主交叉编译全部目标，但会内嵌宿主架构的原生插件，故 CI 在各自原生 runner 上构建以得到正确的 `better_sqlite3.node`。
- Linux 二进制动态链接宿主 glibc：请在**尽量旧的 glibc 环境**（如 CentOS 7 / manylinux 容器）里构建以最大化兼容；**不支持 musl (Alpine)**。
- Desktop 用 electron-builder；macOS / Windows 的签名需在对应宿主并配好证书。

</details>

---

源码：https://github.com/dtssv/CodePilot
