# CodePilot 差距补齐总结与后续版本路线图

> 本文档总结了截至 2026-09-10 的差距补齐工作，并规划后续版本的设计方向。
> 参考项目：claude-code、codex、opencode、deepseek-harness。

## 一、当前已完成事项

### 1.1 总体状态

| 指标 | v2 重构前 | 当前 | 变化 |
|---|---|---|---|
| 总代码行数 | ~5,000 | **30,101** | +25,101 |
| 包数量 | 1 (core) | **6** (core/protocol/sdk/tui/vscode/idea) | +5 |
| 工具数量 | ~10 | **24** (含 MCP 动态注册) | +14 |
| 测试数量 | ~50 | **504** (core 423, tui 54, protocol 27) | +454 |
| 配置层数 | 3 (defaults/user/env) | **7** (defaults/managed/user/repo/mcp-json/env/caller) | +4 |
| 内置斜杠命令 | 5 | **17** (含 /mcp /hooks /agents /skills /context /plugins) | +12 |

### 1.2 各包代码量

| 包 | 行数 | 职责 |
|---|---|---|
| `@codepilot/core` | 20,499 | Agent 内核：session/agent loop/tools/providers/hooks/MCP/permissions/sandbox/config/telemetry/plugins |
| `@codepilot/protocol` | 1,549 | JSON-RPC 2.0 协议层 + headless CLI 入口 |
| `@codepilot/sdk` | 309 | Agent SDK（脚本/CI/后端嵌入） |
| `@codepilot/tui` | 3,936 | Ink 终端 UI（协作模式/权限/问题/diff 高亮） |
| `codepilot-vscode` | 2,269 | VSCode 扩展 |
| `codepilot-idea` | 1,539 | IntelliJ IDEA 插件 (Kotlin) |

### 1.3 已补齐的差距清单（共 33 项中完成 26 项）

#### ✅ 高优先级 10/10 — 全部完成

| # | 差距 | 来源 | 实现提交 |
|---|---|---|---|
| 1 | 子代理 worktree isolation | claude-code | c55bfe7 |
| 2 | Hook handler 类型扩展 (http/mcp_tool/prompt/agent) | claude-code/codex | 3e53e68 |
| 3 | PreToolUse updatedInput 重写 | codex | c55bfe7 |
| 4 | Hook trust 机制（按 hash review） | codex | 3e53e68 |
| 5 | 企业 managed/MDM 配置层 | claude-code/codex | 3e53e68 |
| 6 | model_reasoning_effort / verbosity | codex | c55bfe7 |
| 7 | 后台记忆提取 agent (AutoDream) | claude-code | c55bfe7 |
| 8 | 子代理并发控制 (max_threads) | codex | c55bfe7 |
| 9 | OS 级网络出口代理 (sandbox) | claude-code | c55bfe7 |
| 10 | granular approval_policy | codex | c55bfe7 |

#### ✅ 中优先级 16/16 — 全部完成

| # | 差距 | 来源 | 实现提交 |
|---|---|---|---|
| 11 | Slash 命令系统 (.codepilot/commands/*.md) | claude-code | c55bfe7 |
| 12 | Plugins 打包分发 + marketplace | claude-code | 3e53e68 |
| 13 | doom_loop 死循环检测 | opencode | c55bfe7 |
| 14 | spawn_agents_on_csv CSV 批量并行 | codex | 3e53e68 |
| 15 | NotebookEdit 工具 (Jupyter) | claude-code | 3e53e68 |
| 16 | write_stdin 交互式长进程输入 | codex | 3e53e68 |
| 17 | Agent SDK (TS 嵌入) | claude-code | 3e53e68 |
| 18 | Headless --output-format json/stream-json | claude-code | 9388790 |
| 19 | OpenTelemetry 可观测性 | claude-code | 3e53e68 |
| 20 | 自定义 statusLine 脚本 | claude-code | 3e53e68 |
| 21 | Keyless transcript replay 测试模式 | deepseek-harness | 3e53e68 |
| 22 | model-visible equals logged 断言 | deepseek-harness | 3e53e68 |
| 23 | Fail-closed SANDBOX_UNAVAILABLE | deepseek-harness | c55bfe7 |
| 24 | MCP 工具名 64 字符归一化 + hash | deepseek-harness | 3e53e68 |
| 25 | .mcp.json 项目级 MCP 配置文件 | claude-code | c55bfe7 |
| 26 | /mcp /hooks /agents /skills /context /plugins 管理命令 | claude-code/codex | 3e53e68 |

### 1.4 核心模块清单

**内置工具（24 个）**：
`apply_patch` `ask_user` `bash` `bash_kill` `bash_output` `diagnostics` `edit_file`
`glob` `grep` `ls` `memory_write` `notebook_edit` `plan_update` `read_artifact`
`read_file` `read_image` `skill` `task` `web_fetch` `web_search` `write_file`
`write_stdin` + 动态注册的 MCP 工具

**核心模块（20,499 行）**：
- `session.ts` (1,600+) — 事件溯源 session、turn-scoped overrides、MCP 启动、telemetry
- `agent.ts` (700+) — Agent loop、tool 并行执行、doom_loop 检测、consistency 断言
- `mcp.ts` (1,500+) — stdio/SSE/HTTP 三传输、OAuth 2.1/PKCE、工具名归一化
- `hooks.ts` (600+) — 9 事件 × 5 handler 类型、trust 机制、updatedInput 重写
- `config.ts` (600+) — 7 层合并、managed/MDM、env 插值
- `permissions.ts` — claude-code 语法 allow/ask/deny + "always" 收窄
- `sandbox.ts` — macOS Seatbelt / Linux bwrap / Windows WSL + 路径守卫
- `slashCommands.ts` — .codepilot/commands/*.md 发现 + 参数插值
- `customAgents.ts` — .codepilot/agents/*.md 发现
- `skills.ts` — SKILL.md 三源发现 + 渐进披露
- `plugins.ts` — 插件发现/安装/卸载/marketplace
- `telemetry.ts` — OTLP/HTTP-JSON export
- `replayProvider.ts` — 无 API key 测试
- `consistency.ts` — model-visible equals logged 断言
- `statusLine.ts` — 自定义状态栏脚本
- `management.ts` — /mcp /hooks /agents /skills /context 数据聚合

### 1.5 CodePilot 独有优势（继续保持）

1. **多模型 + provider failover** — 比 claude-code（Anthropic 绑定）更开放
2. **三传输 MCP + OAuth 2.1/PKCE** — 比 codex 的 rmcp 更成熟
3. **结果脱敏** — 私钥/token/连接串自动脱敏，独特安全特性
4. **artifact 化按需取回 + 分层 prompt cache** — Token 效率
5. **9 个 Hook 事件 × 5 种 handler 类型** — 事件覆盖超越参考项目
6. **快照/rewind** — claude-code/codex 都没有的文件级回退
7. **goal 模式** — 长周期任务执行
8. **ask_user_question** — 结构化交互提问
9. **Agent SDK** — 可被外部程序/CI/后端嵌入调用
10. **doom_loop 检测** — 防止重复调用死循环

---

## 二、后续版本路线图

### 2.1 剩余差距（7 项，架构级/远期）

以下 7 项属于低优先级远期项目，每项需要独立的大规模设计：

| # | 差距 | 来源 | 预估工作量 | 建议版本 |
|---|---|---|---|---|
| 27 | **"Everything is a Plugin" 运行时** — agent loop 可替换 | deepseek-harness | 极大（架构重构） | v4.0 |
| 28 | **Profile/bundle/patch 三层组合** — 配置组合系统 | deepseek-harness | 大 | v3.5 |
| 29 | **Code Mode** — 模型用 TS SDK 编程组合工具 | opencode/deepseek-harness | 大 | v3.5 |
| 30 | **Agent Teams** — 多 agent 组队协作 | deepseek-harness | 极大（新协议） | v4.0 |
| 31 | **桥接其他 harness 作为子 agent** — 互操作 | deepseek-harness | 中 | v3.5 |
| 32 | **多端覆盖** (Web/iOS/Android/Chrome/Slack) | claude-code | 极大（每端独立） | v4.0+ |
| 33 | **GitHub Action / GitHub App** | claude-code/codex | 中 | v3.0 |

### 2.2 建议的版本规划

#### v3.0（近期，1-2 个月）

**主题：CI/CD 集成与可观测性深化**

| 项目 | 描述 | 依赖 |
|---|---|---|
| GitHub Action / App (#33) | 提供 `codepilot/action` GitHub Action，支持 PR review、issue 处理、自动修复 | Agent SDK (已完成) |
| SDK 测试补全 | 为 `@codepilot/sdk` 补充单元测试和 e2e 测试 | — |
| OTel 深化 | 将 tool_call、llm_call、permission_request 都接入 span | telemetry.ts (已完成) |
| Headless 模式增强 | `--print` 模式支持 `--allowed-tools`、`--max-turns`、`--resume` | headless.ts (已完成) |
| IDEA 插件 Gradle 重编译 | 验证 IDEA 插件在最新 IntelliJ Platform 上的编译 | — |

**设计要点**：
- GitHub Action 基于 `@codepilot/sdk` 的 `run()` 函数，一行 YAML 即可接入
- OTel 深化：在 `agent.ts` 的 `runOneTool` 和 `streamOnce` 中插入 child span
- Headless 增强：cli.tsx 的 `runHeadless` 增加 `allowedTools`/`maxTurns` 参数透传

#### v3.5（中期，3-6 个月）

**主题：可编程性与配置组合**

| 项目 | 描述 | 依赖 |
|---|---|---|
| Code Mode (#29) | 模型生成 TS 代码，通过 `@codepilot/sdk` 编程式组合工具调用 | Agent SDK (已完成) |
| Profile/bundle/patch (#28) | 配置系统支持 profile 切换（dev/test/prod）、bundle 打包、patch 增量覆盖 | config.ts (已完成) |
| 桥接其他 harness (#31) | 将 claude-code/codex 作为子 agent 调用（通过子进程协议适配） | subagent.ts (已完成) |
| Plugin 生态建设 | 提供 5-10 个官方 plugin（代码审查、测试生成、文档生成等） | plugins.ts (已完成) |

**Code Mode 设计要点**：
- 新工具 `code_mode`：模型生成一段 TS 脚本，SDK 在沙箱中执行
- 脚本通过 `@codepilot/sdk` 的 API 调用其他工具（read_file, edit_file, bash 等）
- 适用于复杂操作：批量重构、跨文件分析、数据转换
- 安全：脚本在 sandbox 内运行，无网络访问，文件访问受限

**Profile 设计要点**：
- `config.profiles: { dev: {...}, test: {...}, prod: {...} }`
- CLI flag `--profile dev` 切换
- Patch 层：`--config-patch '{"model":"gpt-4o"}'` 增量覆盖
- Bundle：`codepilot bundle export` / `codepilot bundle import`

#### v4.0（远期，6-12 个月）

**主题：架构级演进**

| 项目 | 描述 | 依赖 |
|---|---|---|
| Everything is a Plugin (#27) | agent loop 本身可被 plugin 替换，实现自定义 agent 运行时 | — |
| Agent Teams (#30) | 多 agent 组队协作协议（leader/worker/specialist 角色分工） | — |
| 多端覆盖 (#32) | Web UI（React）、Chrome 扩展、Slack Bot | Agent SDK + Protocol (已完成) |
| Marketplace 平台 | 在线 plugin marketplace 网站（搜索/评分/一键安装） | plugins.ts (已完成) |

**Plugin 运行时设计要点**：
- 定义 `AgentRuntime` 接口：`prompt()`, `stream()`, `cancel()`, `state()`
- 默认实现 = 当前 `agent.ts` 的 agent loop
- Plugin 可以注册自定义 runtime，完全替换 agent 行为
- 适用于：定制化 agent（如安全审计专用 agent）、实验性算法（如 MCTS 搜索）

**Agent Teams 设计要点**：
- 扩展 `task` 工具：`team: [{ role: "leader", ... }, { role: "worker", ... }]`
- Leader agent 负责任务分解和结果汇总
- Worker agents 并行执行子任务
- 新事件 `team_message`：agent 间通信
- 共享工作区（worktree）支持 agent 间文件传递

### 2.3 技术债务清单

以下是需要逐步偿还的技术债务（非新功能，但影响可维护性）：

| 债务 | 严重程度 | 建议 |
|---|---|---|
| SDK 包无测试 | 中 | v3.0 补充 |
| IDEA 插件未验证编译 | 中 | v3.0 验证 |
| `session.ts` 过大（1,600+ 行） | 中 | v3.5 拆分为 session-core + session-mcp + session-telemetry |
| 新模块缺文档（plugins/telemetry/consistency 等） | 低 | v3.0 补充 docs/ |
| `hashCommand` 使用 `require()` 而非 ESM import | 低 | 改为 `import { createHash }` |
| NotebookEdit 无测试 | 中 | v3.0 补充 |
| write_stdin 无测试 | 中 | v3.0 补充 |
| CSV parse 无独立测试 | 中 | v3.0 补充 |
| Plugins 安装/卸载无测试 | 中 | v3.0 补充 |
| Telemetry export 无集成测试 | 低 | v3.0 补充（mock OTLP server） |

### 2.4 后续任务启动建议

启动新任务时，建议按以下优先级：

1. **立即**：为新增的 7 个模块补充测试（notebook_edit, write_stdin, csv, plugins, telemetry, consistency, replayProvider）— 这是防止回归的基础
2. **近期**：GitHub Action 集成（#33）— 基于 SDK，投入产出比最高
3. **近期**：补充 docs/ 文档（PLUGINS.md, TELEMETRY.md, SDK.md, NOTEBOOK.md）
4. **中期**：Code Mode（#29）— 差异化能力，利用已有 SDK 基础
5. **中期**：Profile/bundle/patch（#28）— 配置系统增强
6. **远期**：Plugin 运行时 + Agent Teams + 多端 — 需要架构评审

---

## 三、提交记录

| 提交 | 内容 |
|---|---|
| `3e53e68` | feat: 补齐 13 项差距（G4/G5/G12/G14/G15/G16/G17/G19/G20/G21/G22/G24/G26） |
| `9388790` | feat(tui): headless --print/--output-format (Track 49) |
| `c55bfe7` | chore + Tracks 47/48 + 前 7 项高优先级差距 |
| `b0ced4d` | feat(core): token estimation + checkpointing |
| `c8691cb` | feat(core): 协作模式内核 + 系统提示词重写 |
| `8c6f80a` | feat: 三端接入协作模式 + 打包命令 |
| `1dd15fc` | feat: v2 完全重构 — headless agent 核心 + TUI + 插件 |
