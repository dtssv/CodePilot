<p align="center"><strong>CodePilot</strong> 是一个在本地运行的编程 Agent。</p>

<p align="center">
一个无头的 Agent 内核，外面套着全屏终端、浏览器、桌面窗和 VS Code / IntelliJ 插件。
</p>

---

CodePilot 在你的仓库里读代码、改代码、跑命令，直到任务完成。

所有界面都连同一个内核进程：同一个会话可以在终端里开始、在浏览器里接着看、在手机上扫码批准权限。

## 特性

- **多界面，一个内核**：全屏终端、浏览器、桌面窗、VS Code、IntelliJ，以及供程序化调用的 SDK。
- **多模型**：Anthropic、OpenAI、Gemini、GitHub Copilot，以及任何 OpenAI 兼容网关。
- **权限与沙箱**：权限决定"要不要问你"，OS 沙箱（macOS / Linux / Windows-WSL）决定"放行后能碰到什么"。危险操作在任何模式下都会再确认一次。
- **仓库内容默认不执行**：项目里的 MCP 服务器、钩子和插件需要你批准才会运行，内容变化后需要重新批准。
- **项目指令与记忆**：读取仓库里的 `AGENTS.md` / `CLAUDE.md` 等作为规则；Agent 自己的笔记单独保存，不进仓库。
- **长会话**：自动压缩上下文；会话以只追加日志保存，可随时恢复，每一轮的改动都能撤销和重做。
- **长任务**：计划、子代理、后台任务、定时任务，以及多轮推进直到完成的 goal 循环。
- **扩展**：MCP、技能（`SKILL.md`）、钩子、插件、自定义子代理和斜杠命令。

## 安装

下载自包含的单文件二进制，**无需预装 Node.js**。

macOS / Linux / Windows（Git Bash 或 WSL）：

```bash
curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1 | iex
```

安装到 `~/.codepilot/bin`（Windows 为 `%USERPROFILE%\.codepilot\bin`）并加入 PATH。

<details>
<summary>指定版本 / 旧版 Windows / 手动下载</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash -s -- --version v1.0.0
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1))) -Version v1.0.0
```

旧系统 / cmd.exe：从 [Releases](https://github.com/dtssv/CodePilot/releases) 下载 `install.cmd` 运行（`install.cmd v1.0.0` 指定版本）。

也可以直接从 Releases 下载对应平台的 `codepilot-<平台>`：`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `win-x64.exe` / `win-arm64.exe`。终端界面、命令行和浏览器界面都在这一个文件里。

</details>

## 快速开始

在你要工作的目录里启动：

```bash
cd /path/to/project
codepilot
```

设置 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 或 `GITHUB_TOKEN` 中的任意一个，或在界面里用 `/connect` 添加密钥，然后直接描述任务。

```bash
codepilot web                                     # 在浏览器里打开同一个会话
codepilot run "给 src/auth.ts 加上输入校验并补单测"     # 非交互执行
codepilot goal "把回调风格 API 迁成 async/await"       # 多轮推进直到完成
codepilot --help                                  # 所有命令
```

### 模式

协作模式（`/agent`）：

- **agent**：默认，改代码、跑命令。
- **plan**：只读调研并产出计划，批准后再执行。
- **chat**：只问答，不改文件、不跑命令。

权限模式（`/mode`）：`ask`（默认，写入和命令都问）、`auto-edit`（文件编辑自动放行）、`auto`（小模型裁决）、`dont-ask`（不问，一律拒绝）、`yolo`（全部放行，危险命令仍会问）。

### 常用命令

- `/model` · `/provider` 切换模型，`/connect` 添加密钥
- `/resume` 继续历史会话，`/compact` 手动压缩，`/undo` · `/redo` 撤销 / 重做改动
- `/web` 在浏览器里打开当前会话，`/remote` 生成手机扫码遥控二维码
- `/init` 生成 `AGENTS.md`，`/export` 导出会话
- `/context` · `/mcp` · `/skills` · `/agents` · `/hooks` 查看运行时状态
- Ctrl+C：忙时取消当前轮，空闲时退出

## 配置

用户配置在 `~/.codepilot/config.json`，项目配置在 `<repo>/.codepilot/config.json`（覆盖同名项）。

```json
{
  "providers": {
    "my-gateway": {
      "provider": "openai",
      "baseURL": "http://127.0.0.1:3456/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "model": "your-model-id"
    }
  },
  "permissionMode": "ask",
  "permissions": { "allow": ["bash(pnpm test *)"], "deny": ["bash(rm -rf *)"] },
  "sandbox": { "mode": "workspace-write" }
}
```

也可以用 `codepilot config` 在命令行管理。

## IDE 插件

从 [Releases](https://github.com/dtssv/CodePilot/releases) 下载：

- VS Code：`codepilot-vscode-*.vsix`，「从 VSIX 安装…」
- IntelliJ：`codepilot-idea-*.zip`，「从磁盘安装插件」

## 开发

```bash
git clone https://github.com/dtssv/CodePilot.git
cd CodePilot
corepack enable
corepack pnpm install
corepack pnpm build

corepack pnpm --filter @codepilot/core test   # 测试
corepack pnpm -r typecheck                    # 类型检查
corepack pnpm package:all -- --all            # 打包全部，输出在 dist/release/
```

| 目录 | 内容 |
|---|---|
| `packages/core` | Agent 内核 |
| `packages/protocol` | JSON-RPC 服务端 / 客户端、命令行入口 |
| `packages/sdk` | 程序化 SDK |
| `apps/{tui,web,desktop,vscode,idea}` | 各端界面 |

贡献代码前请阅读 [AGENTS.md](AGENTS.md)。
