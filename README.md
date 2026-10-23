# CodePilot

Token 高效、可长程执行的编程 Agent：**核心引擎** + **CLI / TUI** + **Web** + **桌面 Agent** + **VS Code / IntelliJ 插件**。各端共用同一套协议与会话模型。

智能与工具执行集中在 headless 核心（`@codepilot/core`）；CLI、TUI、Web、桌面与 IDE 插件是协议客户端，通过 JSON-RPC（stdio 或 WebSocket）驱动同一会话。

---

## 需要什么

| 项 | 要求 |
|---|---|
| Node.js | **≥ 20**（CI 覆盖 20 / 22） |
| 包管理 | **pnpm 9**（仓库已声明 `packageManager`，推荐用 Corepack） |
| 模型密钥 | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GITHUB_TOKEN`，或在配置里写 OpenAI 兼容网关 |
| IDEA 插件（可选） | JDK **17** + 本机 Gradle Wrapper |

---

## 安装（从源码）

```bash
git clone https://github.com/dtssv/CodePilot.git
cd CodePilot
corepack enable
corepack pnpm install
corepack pnpm build
```

把 CLI 链到 PATH（任选其一）：

```bash
# 开发期直接跑构建产物
alias codepilot='node '"$PWD"'/packages/protocol/dist/cli.js'
alias codepilot-tui='node '"$PWD"'/apps/tui/dist/cli.js'

# 或全局 link（需已 build）
corepack pnpm --filter @codepilot/protocol --filter @codepilot/tui link --global
```

验证：

```bash
codepilot --help
```

---

## 配置

用户级：`~/.codepilot/config.json`  
项目级：`<repo>/.codepilot/config.json`（覆盖同名项）

最小示例（OpenAI 兼容网关 + 多模型能力）：

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
  "sandbox": {
    "mode": "workspace-write",
    "writablePaths": []
  },
  "permissionMode": "ask",
  "stopVerify": "off",
  "contextWindow": 200000
}
```

常用字段：

| 字段 | 含义 |
|---|---|
| `providers` | 多厂商预设；Web / TUI `/provider`、`codepilot config` 可切换 |
| `permissionMode` | `ask` / `auto-edit` / `yolo` |
| `sandbox.mode` | `workspace-write`（默认）/ `read-only` / `off` |
| `sandbox.writablePaths` | 额外可写目录（OS 沙箱） |
| `contextWindow` | 上下文硬上限；超限会触发压缩 |
| `stopVerify` | 默认 `off`；`prompt` / `tests` 为结束前完成校验（可选） |
| `mcpServers` | MCP（stdio / SSE / Streamable HTTP） |

项目记忆：仓库根 `CODEPILOT.md`。  
配置 CLI：`codepilot config show|providers|add|use|templates|remove`。

---

## 怎么用

### 一次性任务

```bash
export OPENAI_API_KEY=...   # 或 ANTHROPIC_API_KEY / GITHUB_TOKEN

codepilot run "给 src/auth.ts 加上输入校验并补单测"
codepilot run "…" --cwd ~/proj --permission-mode auto-edit --json
```

### 长程目标

```bash
codepilot goal "把回调风格 API 迁成 async/await" --max-rounds 50
```

### 交互 REPL / TUI

```bash
codepilot                 # TTY 下进入多轮 REPL
codepilot-tui             # Ink 终端 UI

# REPL 内：/mode chat|plan|agent、/model、/provider、/clear、/exit
# Ctrl+C：忙则取消当前轮，空闲则退出
```

### Web UI（本机协议 + SPA）

```bash
codepilot serve --web --web-root
# 默认 http://127.0.0.1:18765 ，启动会打印 token 并尝试打开浏览器
```

常用参数：`--port`、`--host`、`--token`、`--no-open`、`--no-auth`（仅可信网络）、`--daemon`（无界面守护，供 IDE 复用）。

终端可挂到正在跑的 serve：

```bash
codepilot connect                 # 默认 127.0.0.1:18765
codepilot connect 127.0.0.1:18765 --token <token>
```

### Agent 窗 / 桌面端

```bash
codepilot agent ~/my-project      # 浏览器应用窗，关窗退出
corepack pnpm desktop             # Electron（apps/desktop）
```

### 协作模式

| 模式 | 行为 |
|---|---|
| `chat` | 只问答：禁用写文件 / bash |
| `plan` | 只读探索 + 出计划，不改仓库 |
| `agent` | 默认：全工具 + 权限审批 |

图形端输入框切换「问答 / 计划 / 智能体」；TUI：`/mode …` 或启动参数 `--mode`。

### IDE 插件

```bash
# VS Code
corepack pnpm package:vscode
# 产物：apps/vscode/*.vsix → 扩展「从 VSIX 安装」

# IntelliJ（需 JDK 17）
corepack pnpm package:idea
# 或：cd apps/idea && ./gradlew buildPlugin
# 产物：apps/idea/build/distributions/*.zip
```

插件会拉起本机 `codepilot serve`（或附加已有 daemon），经宿主桥收发 JSON-RPC。

---

## 仓库结构

```
packages/core       Agent 引擎：模型、工具、压缩、会话、权限、沙箱、MCP、hooks
packages/protocol   JSON-RPC + `codepilot` CLI（serve / run / goal / agent / connect）
packages/sdk        程序化调用 SDK
apps/tui            终端 UI（Ink）
apps/web            共享图形界面（Web / Agent / IDE 内嵌）
apps/desktop        Electron 外壳
apps/vscode         VS Code 扩展
apps/idea           IntelliJ 插件（Kotlin / JCEF）
scripts/package     本地打包脚本（输出 dist/release/）
```

### 引擎侧能力（实现已具备）

- **上下文**：按配置 `contextWindow` 做中途压缩 / 硬裁剪；用量超阈会强制压缩，避免本地估算偏低导致超窗
- **沙箱 + 交付根**：OS 可写白名单与任务交付目录；沙箱已放行的路径不再重复询问交付授权
- **后台 job**：`bash(run_in_background)` + `bash_output` / `bash_kill`；引擎进程退出时级联停止
- **权限**：`ask` / `auto-edit` / `yolo`；危险命令仍会确认
- **Stop 校验**：`stopVerify` 默认关闭；开启时续跑反馈不进入用户气泡
- **429**：传输层重试；成功后界面清除限流横幅

---

## 开发

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint          # Biome；CI 以 error 级别门禁

# 常用
corepack pnpm --filter @codepilot/core test
corepack pnpm --filter @codepilot/web build
corepack pnpm desktop
```

CI：推送 / PR 到 `main` 触发 `.github/workflows/ci.yml`（lint、矩阵 build+test、core coverage、IDEA Gradle）。

---

## 发版（GitHub Release）

推送符合 `v*.*.*` 的 tag 会跑 `.github/workflows/release.yml`，自动：

1. `pnpm build` + test  
2. 打包 npm tarball（`@codepilot/core` / `protocol` / `tui`）  
3. 打包 VS Code `.vsix`、IDEA `.zip`  
4. 创建 **GitHub Release** 并挂上产物（npm 另需仓库 Secret `NPM_TOKEN` 才会 publish）

示例：

```bash
# 1. 合并并推送到 main
git push origin main

# 2. 打 tag 并推送（触发 Release 工作流）
git tag v2.1.0
git push origin v2.1.0
```

Release 页：https://github.com/dtssv/CodePilot/releases  

本地也可：

```bash
corepack pnpm package:npm      # packages/*.tgz
corepack pnpm package:vscode
corepack pnpm package:idea
# 完整本地脚本（可选）：node scripts/package/all.mjs → dist/release/
```

---

## 许可证与仓库

- 源码：https://github.com/dtssv/CodePilot  
- Issue / CI：仓库 Actions 与 Issues  
