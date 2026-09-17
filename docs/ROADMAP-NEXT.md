# CodePilot 后续功能完善推进计划

> 基于 2026-09-10 当前代码状态（48,904 行源码 / 983 测试 / 26 工具 / 9 层配置），
> 覆盖 v3.5 收尾、v4.0 架构演进、以及持续改进三条主线。
>
> **2026-09-11 更新**：v3.5 收尾、CI/CD 强化、Core 模块优化（§一~§三）已全部完成，
> 详见各章节的 ✅ 标记。下一步进入 v4.0 架构演进（§四）。
>
> **2026-09-15 更新**：§4.1 Plugin 运行时 **全部 4 个 Phase 已完成**
> （接口 + 插件加载 + 两个示例 runtime + hook 集成与文档）；
> §4.2 Agent Teams **全部 5 个 Phase 已完成**（角色分工 + 拆解 + team_message +
> 共享 worktree + 冲突检测 + 三种合并策略 + TUI/CLI 渲染）；
> §4.3 Web UI **Phase 1 + Phase 2 已完成**（WebSocket 传输 +
> `codepilot serve --web`，含 token/Origin/心跳/掉线清理；`apps/web/` React SPA
> 含聊天/diff/权限确认/会话管理）。
> 下一步 §4.3 Phase 3：文件浏览器 + Monaco + xterm。

---

## 当前状态快照

| 指标 | 数值 | 备注 |
|------|------|------|
| 总源码行数 | **~37,900** | 仅 src（不含测试）：core 24,472 + tui 4,244 + idea 2,504 + vscode 2,272 + web 2,086 + protocol 2,043 + sdk 309。此前各包的口径不一致（部分含测试），这里统一为 src-only |
| 测试用例 | **1,012** | core 759 + web 44 + sdk 19 + tui 72 + protocol 48 + vscode 70 |
| 测试文件 | **67** | core 49 + web 4 + sdk 1 + tui 6 + protocol 4 + vscode 3 |
| 内置工具 | **26** | 含 code_mode + harness_bridge（v3.5 新增） |
| 配置层数 | **9** | defaults → managed → user → repo → mcp-json → env → caller → profile → patch |
| 文档 | **23 篇** | 新增 CODE_MODE / HARNESS_BRIDGE / BUNDLE / PLUGINS / SDK / NOTEBOOK / RUNTIME / TEAMS / WEB |
| 官方插件 | **7 个** | code-review / test-gen / doc-gen / refactor / security-audit / perf-profile + runtime-example（runtime 参考实现） |
| CI 门禁 | **lint + typecheck + test + coverage + IDEA** | 3 平台 × 2 Node 版本 matrix |

### v3.0 + v3.5 完成情况

| 版本 | 状态 | 完成项 |
|------|------|--------|
| v3.0 | ✅ 全部完成 | GitHub Action、SDK 测试、OTel 深化、Headless 增强、IDEA 编译验证 |
| v3.5 | ✅ 全部完成 | Code Mode、Profile/bundle/patch、Harness Bridge、Plugin 生态、session.ts 拆分 |
| v3.5 收尾 | ✅ 全部完成 | 新模块文档、VSCode/IDEA 测试、系统提示词接入、CI/CD 强化、Core 模块拆分 |

---

## 一、v3.5 收尾（1-2 周）✅ 已完成

> 主题：补齐 v3.5 新增模块的文档 + 测试覆盖收尾

### 1.1 新增模块文档（优先级：高）

当前 `code_mode`、`harness_bridge`、`bundle` 三个新模块缺少独立文档。

| 文档 | 内容 | 预估工作量 |
|------|------|-----------|
| `docs/CODE_MODE.md` | code_mode 工具使用指南：API 表面（readFile/writeFile/editFile/bash/grep/glob/ls）、安全模型（vm sandbox + 权限管道）、示例（批量重构、跨文件分析、数据转换）、与 task 工具的对比 | 0.5 天 |
| `docs/HARNESS_BRIDGE.md` | harness_bridge 工具使用指南：三种 harness 类型（claude-code/codex/custom）、输出适配（JSON envelope 解析）、安全限制（沙箱/超时/截断）、示例 | 0.5 天 |
| `docs/BUNDLE.md` | Bundle 导出/导入指南：bundle 格式（version/config/commands/agents/skills）、CLI 用法（`bundle export`/`bundle import`）、与 Profile 的配合使用 | 0.5 天 |

### 1.2 VSCode 扩展测试（优先级：高）

VSCode 扩展有 2,269 行代码、6 个源文件，但 **0 个测试**。这是当前最大的测试盲区。

| 任务 | 描述 | 预估工作量 |
|------|------|-----------|
| VSCode 扩展单元测试 | 为 `client.ts`（JSON-RPC stdio 客户端）、`sidebar.ts`（Webview 面板）、`config.ts`（设置存储）编写单元测试。使用 vscode-test 或手动 mock VSCode API。 | 2 天 |
| VSCode 扩展集成测试 | 启动真实 VSCode 实例 + codepilot serve 子进程，验证端到端消息流。 | 1 天 |

### 1.3 IDEA 插件测试 + CI 集成（优先级：高）

IDEA 插件有 1,540 行 Kotlin 代码、6 个文件，但 **0 个测试** 且 **不在 CI 中**。

| 任务 | 描述 | 预估工作量 |
|------|------|-----------|
| IDEA 插件单元测试 | 为 `CodepilotClient.kt`（JSON-RPC 客户端）、`CodepilotService.kt`（服务层）编写 Kotlin 测试。使用 JUnit 5 + MockK。 | 1.5 天 |
| IDEA CI 集成 | 在 `ci.yml` 中添加 Gradle 构建步骤（`./gradlew compileKotlin`），使用 `gradle/actions/setup-gradle@v4`。需要 JDK 17 runner 或 toolchain。 | 0.5 天 |

### 1.4 新工具系统提示词接入（优先级：中）

`code_mode` 和 `harness_bridge` 已注册到工具表，但系统提示词中没有对应的使用指导。模型可能不知道何时该用这些工具。

| 任务 | 描述 | 预估工作量 |
|------|------|-----------|
| 系统提示词更新 | 在 `systemPrompt.ts` 中为 `code_mode` 和 `harness_bridge` 添加使用场景说明和示例 | 0.5 天 |
| toolDocs 更新 | 在 `tools/toolDocs.ts` 中为两个新工具添加 `TOOL_REFERENCE` 条目 | 0.5 天 |

---

## 二、CI/CD 强化（1 周）✅ 已完成

> 主题：让 CI 从"能跑"变成"能守"

### 2.1 CI 流水线增强

当前 CI 只有 typecheck + build + test，缺少质量门禁。

| 任务 | 描述 | 预估工作量 |
|------|------|-----------|
| Lint 步骤 | 集成 Biome（或 ESLint）到 CI，对 TS 代码做静态检查。配置 `biome.json` 规则集。 | 0.5 天 |
| 测试覆盖率 | 集成 c8/vitest coverage，设定最低覆盖率阈值（建议：core ≥80%，其他包 ≥60%），在 CI 中报告。 | 0.5 天 |
| 跨平台测试 | 添加 macOS + Windows runner 到 CI matrix（当前仅 ubuntu-latest）。 | 0.5 天 |
| IDEA 构建验证 | 如 1.3 所述，添加 Gradle 编译步骤。 | （含在 1.3） |

### 2.2 发布自动化

| 任务 | 描述 | 预估工作量 |
|------|------|-----------|
| npm 发布工作流 | 添加 `release.yml`：tag 触发 → 构建 → 发布 core/protocol/sdk/tui 到 npm。 | 1 天 |
| VSCode 扩展打包 | 添加 `.vsix` 打包步骤到 CI（或 release workflow），使用 `vsce package`。 | 0.5 天 |
| IDEA 插件打包 | 添加 `./gradlew buildPlugin` 步骤到 release workflow，产出 `.zip` 分发包。 | 0.5 天 |

---

## 三、Core 模块优化（2-3 周）✅ 已完成

> 主题：偿还新产生的技术债务，为 v4.0 架构演进做准备

### 3.1 mcp.ts 拆分（优先级：高）

`mcp.ts` 现在是最大单模块（1,587 行），包含 stdio/SSE/HTTP 三传输 + OAuth 2.1/PKCE + 工具名归一化 + 资源/提示管理。

| 拆分方案 | 文件 | 内容 | 预估行数 |
|----------|------|------|---------|
| `mcp.ts`（入口） | McpManager + McpClient 接口 + 共享类型 | ~300 |
| `mcp-stdio.ts` | McpStdioClient（子进程 stdio 传输） | ~350 |
| `mcp-sse.ts` | McpSseClient（HTTP SSE 传输） | ~350 |
| `mcp-oauth.ts` | OAuth 2.1/PKCE 流程（已有独立文件，检查是否完全分离） | ~200 |
| `mcp-tools.ts` | 工具名归一化 + 资源/提示自动包装 | ~200 |
| `mcp-types.ts` | 共享类型定义（McpToolDescriptor, McpServerConfig 等） | ~100 |

**预估工作量**: 2 天（含测试适配）

### 3.2 agent.ts 进一步分解（优先级：中）

`agent.ts` 当前 806 行，包含 agent loop + provider 消息构建 + 工具执行 + 权限检查 + doom loop + telemetry span。

| 拆分方案 | 文件 | 内容 |
|----------|------|------|
| `agent.ts`（入口） | `runAgent()` 主循环 | ~300 |
| `agent-messages.ts` | `buildProviderMessages()` + `compactTranscriptToProviderMessages()` | ~150 |
| `agent-tools.ts` | `runOneTool()` + 权限/Hook/doom-loop 集成 | ~250 |
| `agent-stream.ts` | `streamOnce()` + provider 交互 | ~100 |

**预估工作量**: 1.5 天（含测试适配）

### 3.3 hooks.ts 拆分（优先级：低）

`hooks.ts` 当前 755 行，包含 9 事件 × 5 handler 类型。

| 拆分方案 | 文件 | 内容 |
|----------|------|------|
| `hooks.ts`（入口） | HookEngine 类 + 事件注册 | ~250 |
| `hooks-handlers.ts` | 5 种 handler 类型的执行逻辑（command/http/mcp_tool/prompt/agent） | ~300 |
| `hooks-trust.ts` | trust 机制（hash 计算 + 审查 + 持久化） | ~150 |

**预估工作量**: 1 天（含测试适配）

---

## 四、v4.0 架构演进（6-12 个月，按优先级排序）

> 主题：从"单体 agent"到"可编程 agent 平台"

### 4.1 Plugin 运行时（#27）✅ 已完成

> **Phase 1 已完成** ✅ — `packages/core/src/runtime.ts`：定义了 `AgentRuntime`
> 接口（`prompt()` / `stream()` / `cancel()` / `state()`）、`RuntimeFactory`、
> `RuntimeRegistry`（进程级 `runtimeRegistry`，预注册 default），并将现有
> `agent.ts` 的 `runAgent()` 包装为 `DefaultRuntime`。`Session` 通过
> `runtimeRegistry.resolve(config.runtime)` 解析运行时，未配置时与之前行为
> 完全一致（公共 API 无变化）。新增 `packages/core/test/runtime.test.ts`（9 个
> 测试，覆盖注册/解析/未知名抛错/DefaultRuntime 与 runAgent 等价性/stream）。
> 导出已加入 `index.ts`。
>
> **Phase 2 已完成** ✅ — `plugin.json` 新增 `runtime` 字段（字符串简写或
> `{module, name?, default?}`）；`loadPluginRuntimes()` 动态 import 并注册
> factory，逐插件 fail-soft；`initPluginRuntimes()` 汇总注册结果 + 错误 +
> 插件声明的 default，并被 `createSession()` 自动调用（`pluginRuntimes: false`
> 可跳过）。解析优先级 `opts.runtime → config.runtime → 插件 default`。
> 同时修掉两个 Phase 2 遗留缺陷：①`config.runtime` 从未加入 zod schema，
> 写进配置文件会被 strict 校验拒绝（连带补上 `runtimeOptions`）；
> ②清单省略 `runtime.name` 时，声明的 default 用的是**插件名**而注册用的是
> **factory 名**，会导致下一次 prompt 报 "Unknown agent runtime"。
> 加载失败的插件不再被选为 default（否则加载告警会升级成硬失败）。
> 新增 `test/pluginRuntimeSession.test.ts`（9 个测试）。
>
> **Phase 3 已完成** ✅ — 两个示例 runtime，位于 `packages/core/src/runtimes/`，
> 导入 core 即注册（不配置则不生效）：
> - `audit`（`audit.ts`）：只读 + 强制报告格式。工具表过滤到只读集合、每次调用
>   出口再查模式门禁；终稿缺 Summary/Findings/Recommendations 时额外花一轮要求
>   重写，仍不合格则发 `error` 事件而不是把半成品当审计结论。
> - `mcts`（`mcts.ts`）：扁平蒙特卡洛搜索（expand → simulate → select →
>   exploit）。N 个**只读** rollout 探索不同角度，评分后选优，最后在会话原本模式
>   下执行；评分板作为 `[mcts runtime]` 消息落进 transcript 以便复盘。
>   选项走 `config.runtimeOptions.mcts`。
> - 可运行的插件参考实现：`plugins/runtime-example/`（自包含 `.mjs`，不 import core）。
>
> **Phase 4 已完成** ✅ — Hook 集成的关键是 `RuntimeToolkit`：factory 通过
> `deps.toolkit` 拿到 `runDefault()` / `runTool()` / `visibleTools()` /
> `redactToolOutput()`，插件因此**无需 import core**（从
> `~/.codepilot/plugins/` 加载时根本解析不到）。`runTool()` 走完整管道
> （模式门禁 → doom-loop → 权限 → PreToolUse → Zod 校验 → 执行 →
> PostToolUse → telemetry），直接调 `tool.execute()` 则会静默绕过全部环节——
> 这是自定义 runtime 最隐蔽的错误来源。循环外的 hook
> （SessionStart/UserPromptSubmit/Stop/Pre|PostCompact）仍由会话层触发，
> 自定义 runtime 无需关心。文档见 `docs/RUNTIME.md`；
> 新增 `test/runtimeExamples.test.ts`（33 个测试）。

**目标**：agent loop 可被 plugin 替换，实现自定义 agent 运行时。

**设计要点**：

```
┌─────────────────────────────────────────────┐
│                 Session                      │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         AgentRuntime (interface)       │  │
│  │  prompt() / stream() / cancel() /      │  │
│  │  state() / getEvents()                 │  │
│  └──────────────┬─────────────────────────┘  │
│                 │                            │
│     ┌───────────┴───────────┐               │
│     │                       │               │
│  ┌──▼──────────┐  ┌────────▼───────┐       │
│  │ DefaultRuntime│  │ PluginRuntime  │       │
│  │ (agent.ts)   │  │ (plugin-provided)│      │
│  └─────────────┘  └────────────────┘       │
└─────────────────────────────────────────────┘
```

**实现步骤**：

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| Phase 1 ✅ | 定义 `AgentRuntime` 接口 + `RuntimeFactory` 注册机制。将现有 `agent.ts` 的 `runAgent()` 包装为 `DefaultRuntime`。不改变任何公共 API。 | 1 周 |
| Phase 2 ✅ | Plugin manifest 新增 `runtime` 字段，plugin 可以声明一个 JS/TS 模块作为自定义 runtime。Session 在初始化时检查 plugin runtime 并加载。 | 1 周 |
| Phase 3 ✅ | 提供 2 个示例 runtime：(a) MCTS 搜索 runtime（用于探索性任务），(b) 安全审计 runtime（只读 + 强制报告格式）。 | 1 周 |
| Phase 4 ✅ | 文档 + 测试 + 与 hook 系统的集成（自定义 runtime 也需要触发 hooks）。 | 0.5 周 |

**关键接口**：

```typescript
interface AgentRuntime {
  /** Run a single prompt to completion. */
  prompt(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult>;
  /** Stream events as they happen. */
  stream?(input: AgentRunInput, deps: AgentDeps): AsyncIterable<Event>;
  /** Cancel the current run. */
  cancel(): void;
  /** Get current runtime state. */
  state(): "idle" | "running" | "waiting_permission";
}

interface RuntimeFactory {
  name: string;
  create(deps: RuntimeDeps): AgentRuntime;
}
```

### 4.2 Agent Teams（#30）

> **全部 5 个 Phase 已完成** ✅ — 实现在 `packages/core/src/teams.ts`（`runTeam()`），
> 通过 `task` 工具的 `team` / `merge_strategy` / `shared_worktree` 字段暴露。
> 文档见 `docs/TEAMS.md`；新增 `test/teams.test.ts`（36 个）+
> `test/taskTeam.test.ts`（6 个）。
>
> **Phase 1（角色 + 拆解）** — 成员就是子代理，复用 `SubagentRunner`，team 加的是
> 它们之外的编排。`leader` 固定只读（`explore`）：leader 一边改文件、worker 一边改
> 同一批文件，正是这套结构要避免的冲突。worker 不写 `objective` 时由 leader 调研后
> 用结构化 JSON 派活（`parseAssignments`）；已经写了 objective 的成员不会被覆盖，
> roster 里标成"已领活"避免 leader 重复安排。leader 派活失败退回团队目标 + notes。
>
> **Phase 2（team_message）** — 没走"共享事件总线"：成员并行且互不通信，总线没有
> 消费者。事件的真实用途是**给人复盘**，所以 `team_message`（from/to/content/
> timestamp/kind）持久化 + 推给 UI，但**对模型不可见**——
> `compactTranscriptToProviderMessages` 忽略它，compaction/checkpoint 的 token
> 估算也按 0 计（否则会为模型从未见过的 token 提前压缩）。父 agent 照常从 `task`
> 返回值里读结果。工具能发这类事件靠新增的 `ToolContext.emitEvent`，它直连宿主而
> **不进** agent 循环的 `produced` 数组（循环按位置索引该数组来挂 tool_result 块）。
>
> **Phase 3（共享工作区）** — `shared_worktree: true` 时全队跑在**同一个** worktree
> 里，成员因此能看到彼此的产出。**故意不支持**每人一个 worktree：那样互相看不见，
> 也就谈不上协作（需要隔离的用 `tasks` + `isolation: "worktree"`）。结束时删目录、
> **保留分支**（那是产出），返回分支名 + `git diff --stat`。非 git 仓库退回父 cwd + notes。
>
> **Phase 4（汇总 + 冲突检测）** — 冲突检测靠记录每个成员 `write_file` /
> `edit_file` / `apply_patch` / `notebook_edit` 的目标路径，同一路径出现在 2+ 成员
> 名下即冲突，会发 `team_message`、进 leader 的合并提示、并出现在最终报告里。这是
> **文件级**检测，不是行级 merge（`bash` 里的 `sed -i` 检测不到）。三种 merge 策略：
> `leader_summary`（有 leader 时默认）/ `voting`（按"独立同结论人数 + 证据质量"选一份
> 原样返回，成功成员 <2 时退回 concat）/ `concat`（无 leader 时默认，不额外调模型）。
> **任何合并调用失败都退回 concat** 而不是让整个 team 白跑；实际生效的策略在
> `mergeStrategy` 里，所有降级都记进 `notes`。
>
> **Phase 5（TUI/CLI）** — TUI 新增 `team` row（`⇄ [kind] from → to`，assignment/
> conflict 全文、conclusion 截断），headless CLI 渲染 `[team:kind]` 行。没做独立的
> "团队进度面板"：事件按时间顺序混在主流里更符合现有渲染模型，成员状态本身也就是
> status/conclusion 两条消息。
>
> 顺带修掉一个真实竞态：`writeJobStdin` 把"任务已退出"和"stdin 已关闭"都压成
> `false`，而 `write_stdin` 在检查状态和写入之间存在窗口——同一场景会随机产出两种
> 报错（`writeStdin.test.ts` 的间歇性失败就是它）。改成返回带 reason 的结果，
> 报错文案也从"可能关闭了 stdin"变成可执行的建议。

**目标**：多 agent 组队协作协议（leader/worker/specialist 角色分工）。

**设计要点**：

```
User: "重构整个认证模块"
  │
  ▼
┌──────────────────────────────────────┐
│           Leader Agent               │
│  - 分解任务为子任务                    │
│  - 分配给 worker/specialist           │
│  - 汇总结果                           │
│  - 处理冲突                           │
└──────┬──────┬──────┬────────────────┘
       │      │      │
  ┌────▼─┐ ┌──▼───┐ ┌▼─────────┐
  │Worker│ │Worker│ │Specialist│
  │(前端)│ │(后端)│ │(安全审计) │
  └──────┘ └──────┘ └──────────┘
       │      │      │
       ▼      ▼      ▼
   共享工作区 (worktree)
```

**实现步骤**：

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| Phase 1 ✅ | 扩展 `task` 工具：新增 `team` 字段，接受 `[{ role, objective, agent_type?, tools?, model? }]` 数组。Leader agent 收到团队描述后分解任务。 | 1 周 |
| Phase 2 ✅ | 实现 `team_message` 事件类型：agent 间通信（改为对模型不可见的复盘日志，见上）。Worker 完成后发送结果给 Leader。 | 1 周 |
| Phase 3 ✅ | 共享工作区：所有 team 成员在同一个 worktree 中工作（每人一个 worktree 故意不做，见上）。 | 1 周 |
| Phase 4 ✅ | Leader 结果汇总：收集所有 worker 的结论，生成综合报告。冲突检测（两个 worker 修改同一文件）。 | 1 周 |
| Phase 5 ✅ | TUI 集成：团队通信日志（独立进度面板未做，见上）。 | 0.5 周 |

**关键接口**：

```typescript
// task 工具扩展
interface TeamSpec {
  team: Array<{
    role: "leader" | "worker" | "specialist";
    objective: string;
    agent_type?: string;
    tools?: string[];
    model?: string;
    maxSteps?: number;
  }>;
  /** How to merge worker results. */
  merge_strategy?: "leader_summary" | "voting" | "concat";
  /** Shared worktree for all team members. */
  shared_worktree?: boolean;
}

// 新事件类型
interface TeamMessageEvent {
  type: "team_message";
  from: string;        // agent role/name
  to: string | "all";  // target agent or broadcast
  content: string;
  timestamp: number;
}
```

### 4.3 多端覆盖（#32）

**目标**：Web UI（React）、Chrome 扩展、Slack Bot。

**建议优先级**：Web UI > Slack Bot > Chrome 扩展

> **Web UI Phase 1 已完成** ✅ — `packages/protocol/src/ws.ts`：
> `WebSocketTransport`（`RpcTransport` 的 WS 实现）+ `startWebSocketServer()`，
> 入口 `codepilot serve --web [--port/--host/--token/--allow-origin/--no-auth]`。
> 协议本身不变，只换了承载方式，所以 stdio 客户端一行都不用改。
>
> - **一个连接一个 peer**：每个 WS 连接有独立的会话表，两个标签页互不可见
>   （A 的 sessionId 在 B 上是 `SessionNotFound`）。掉线靠 `session/resume` 恢复。
> - **掉线清理**：浏览器标签页可能不发 close 帧就消失，所以新增
>   `ServerHandle.dispose()`（从 `handleShutdown` 抽出的 `teardown`），在 socket
>   关闭时注销订阅 + dispose 会话 + fail-closed 悬空请求；另有 30s ping/pong 心跳，
>   半开连接会被 terminate——否则它会一直占着会话不放。
> - **安全是这个 Phase 的主要工作量**，因为端口前面站着能跑 shell 的 agent：
>   默认只绑 127.0.0.1；随机 token（常量时间比较，query 或 Bearer header）；
>   **Origin 白名单**——WS 升级不受 CORS 约束，任何网页都能连 localhost，没有这道
>   检查用户访问的页面就能驱动他的 agent。不带 Origin 的放过（非浏览器客户端本来
>   不带），带的必须在白名单里。**Origin 先判、token 后判**，免得该端点变成 token
>   探测器。拒绝发生在 HTTP 升级阶段并带 401/403/503 真实状态码。
>   `--no-auth` 配非 loopback `--host` 时 CLI 直接拒绝启动。
> - `ws` 依赖放在 `@codepilot/protocol/ws` **子路径导出**，不进主入口：VSCode
>   扩展用 esbuild 打包且只说 stdio，没理由让它背上一个网络库（已验证 bundle 干净）。
> - 新增 `test/ws.test.ts`（21 个，含真实 HTTP 升级 + 真实 `ws` 帧 + 各条拒绝路径），
>   并用原生 `WebSocket` 客户端对跑起来的 CLI 做过端到端验证。
>
> **Web UI Phase 2 已完成** ✅ — `apps/web/`：React 18 + Vite 5 + Tailwind 4 的
> SPA，文档 `docs/WEB.md`，新增 `test/{reducer,client,diff,prefs}.test.ts`
> （44 个，覆盖率 96%）。
>
> - **状态层是纯函数**：`state/reducer.ts`（事件 → rows）不认识 React 也不认识
>   client，所以增量累积/工具配对/状态机/用量累加都能在 node 里测；组件是薄壳。
>   恢复会话时历史事件走**同一个 reducer 重放**，不存在第二套渲染逻辑。
> - **diff 展示**：协议里没有 diff，工具调用带的是 agent 选的**输入**，所以
>   `state/diff.ts` 从输入推出改动视图（`write_file` 全量新增、`edit_file` 每对
>   search/replace 渲染成先删后加、`global_replace`/`regex` 额外标注因为它们改变了
>   这个 diff 的含义）。这不是 diff 算法，而是「agent 请求的改动」本身——审批前
>   该看的正是它。单 hunk 超 400 行截断。
> - **复用 `Peer`**：新增 `@codepilot/protocol/rpc` 子路径导出（rpc.ts 零依赖），
>   浏览器端不重写 JSON-RPC 关联/反向请求逻辑。对 core 只做 `import type`，
>   构建产物已验证不含 `child_process` / `node:fs` / core 符号。
> - 三个容易错但不显眼的地方：①**用户消息不做乐观渲染**（`agent.ts` 会把它写进
>   转录并由服务端推回，再自己加一条就每句显示两遍）；②**掉线不清空转录**
>   （只标记 disconnected，重连靠 resume 重灌）；③**running 状态不顶掉已弹出的
>   对话框**（agent 等回答时状态事件还在来，照单全收会把权限弹窗关掉）。
> - 安全：token 存 `sessionStorage` 而非 `localStorage`（它等价于本机执行命令的
>   权限，不该活得比标签页久；有测试锁住这个决定），页面带 CSP
>   （`default-src 'self'`，`connect-src` 只允许本机 ws）。
>
> **Phase 3 最小可用版本已完成** ✅ — 协议新增 `workspace/list`、`workspace/read` 与 `workspace/search`，具备 cwd 路径隔离、路径穿越拒绝、512 KiB 读取上限和忽略依赖目录的搜索；`apps/web` 新增 Workspace 面板，支持目录浏览、只读代码查看（行号）、刷新、搜索及大文件截断提示。新增轻量 Terminal 输出面板，实时汇总 transcript 中 bash 工具结果；新增轻量 Terminal 输出面板，实时汇总 transcript 中 bash 工具结果；新增 workspace 搜索协议与 cwd 安全测试；新增受控 `workspace/write` 编辑保存（512 KiB 限制 + expectedSize/sha256 expectedHash 乐观并发检查 + 临时文件原子 rename），Web 端保存前二次确认与轻量 diff 预览；补充写入成功、hash/size 冲突和越界写入测试，并在编辑器中显示 modified 状态；新增只读 `workspace/git-status` 与 `workspace/git-diff` 协议和 Web Git 变更文件树/差异预览，diff 输出限制 512 KiB 并禁用外部 diff/颜色/重命名检测；新增 `workspace/stat` hash 轮询检测，Web 编辑器发现外部修改时提示并阻止过期保存；同步补充 `docs/PROTOCOL.md`、`docs/WEB.md` 的 workspace API 文档与当前状态；git-diff 按字节限制截断，新增真实 Git 临时仓库的 staged/unstaged patch 测试与前端切换。完整 Monaco/xterm 重量级集成仍可作为后续增强。

 > **部署模式 Phase 4 已完成** ✅ — `codepilot serve --web --web-root [DIR]`：
 > `packages/protocol/src/ws.ts` 同端口提供安全的 SPA 静态文件服务（MIME、缓存、
 > 路径穿越防护、extensionless 路由回退 `index.html`、HEAD 支持），WebSocket
 > 升级与静态 GET 共存；CLI 支持显式目录或 `--web-root` 自动探测 `apps/web/dist`。
 > 新增 6 个静态托管测试，protocol 全套 55 个测试通过。

**Web UI 实现步骤**：

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| Phase 1 ✅ | 基于 `@codepilot/protocol` 的 WebSocket 服务器（在 `packages/protocol` 中添加 WS 传输）。 | 1 周 |
| Phase 2 ✅ | React SPA（`apps/web/`）：聊天界面 + diff 高亮 + 权限确认 + 会话管理。使用 Vite + TailwindCSS。 | 3 周 |
| Phase 3 | 文件浏览器 + 编辑器集成（Monaco）+ 终端模拟器（xterm.js）。 | 2 周 |
| Phase 4 ✅ | 部署模式：本地 `codepilot serve --web --web-root [DIR]` 启动 Web UI + 后端（默认可自动探测 `apps/web/dist`）。 | 0.5 周 |

**Slack Bot 实现步骤**：

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| Phase 1 | Slack Bolt 框架集成，接收 slash command / mention。 | 0.5 周 |
| Phase 2 | 将 Slack 消息转换为 SDK prompt，流式返回结果到 Slack thread。 | 1 周 |
| Phase 3 | 权限确认通过 Slack interactive buttons（Approve/Deny）。 | 0.5 周 |

### 4.4 Marketplace 平台

**目标**：在线 plugin marketplace 网站（搜索/评分/一键安装）。

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| Phase 1 | 静态 JSON 索引 + 简单搜索页面（Next.js static site）。Plugin 作者通过 PR 提交到索引仓库。 | 1 周 |
| Phase 2 | `codepilot install <name>` CLI 命令：从 marketplace 索引查找 → git clone → 验证 plugin.json → 安装到 `~/.codepilot/plugins/`。 | 0.5 周 |
| Phase 3 | 评分/评论系统（GitHub Discussions 或 Giscus 集成）。 | 1 周 |
| Phase 4 | 自动安全扫描：对提交的 plugin 做静态分析（检查 hooks 中的危险命令、MCP server 配置等）。 | 1 周 |

---

## 五、持续改进（长期，每周固定投入）

### 5.1 性能优化

| 项目 | 描述 | 目标 |
|------|------|------|
| Prompt cache 命中率提升 | 分析 cache miss 模式，优化 static/dynamic prompt 分层 | cache hit rate > 90% |
| 工具执行并行度 | 当前 `Promise.all` 无限制；添加 per-tool concurrency limit | 避免资源耗尽 |
| 事件持久化批量化 | 当前每个事件都 `appendFile`；批量写入减少 I/O | 减少 50% 磁盘 I/O |
| Token 估算精度 | 当前使用粗略估算；接入 tiktoken/o200k 等真实 tokenizer | 估算误差 < 5% |

### 5.2 安全加固

| 项目 | 描述 |
|------|------|
| MCP server 签名验证 | 对 MCP server 二进制做签名校验，防止供应链攻击 |
| Hook 沙箱化 | Hook 脚本在 vm 沙箱中运行，限制文件系统/网络访问 |
| 插件权限声明 | plugin.json 新增 `permissions` 字段，声明需要的权限（file_write, network, bash 等） |
| 审计日志 | 所有工具调用记录到结构化审计日志，支持导出 |

### 5.3 可观测性深化

| 项目 | 描述 |
|------|------|
| Metrics export | 除 traces 外，导出 metrics（token 使用量、工具调用频率、错误率）到 Prometheus |
| 结构化日志 | 所有日志输出为 JSON 格式，支持 Loki/ELK 收集 |
| Session replay UI | Web 界面回放 session 事件流，用于调试和审计 |

### 5.4 模型支持扩展

| 项目 | 描述 |
|------|------|
| Ollama 本地模型 | 添加 Ollama provider，支持本地 LLM 推理 |
| Azure OpenAI | 添加 Azure OpenAI provider（endpoint + deployment 配置） |
| Google Gemini | 添加 Google AI provider |
| AWS Bedrock | 添加 Bedrock provider（Claude/Llama 等） |
| 模型路由 | 根据任务类型自动选择模型（代码用 Codex，分析用 Claude，快速任务用 Haiku） |

---

## 六、时间线总结

```
2026-09 ──────────────────────────────────────────────── 2027-03
  │                                                        │
  ├── v3.5 收尾（2 周）✅ 完成 ─────────────┤
  │   ├─ ✅ 新模块文档（CODE_MODE/HARNESS_BRIDGE/BUNDLE）
  │   ├─ ✅ VSCode 扩展测试（70 tests, 修复 3 个 bug）
  │   ├─ ✅ IDEA 插件测试 + CI 集成（JUnit5 + MockK）
  │   └─ ✅ 新工具系统提示词接入
  │
  ├── CI/CD 强化（1 周）✅ 完成 ────────────┤
  │   ├─ ✅ Lint（Biome）+ 覆盖率（v8）+ 跨平台（3 OS × 2 Node）
  │   ├─ ✅ IDEA Gradle 构建验证（compileKotlin + test + buildPlugin）
  │   └─ ✅ 发布自动化（release.yml: npm + .vsix + .zip）
  │
  ├── Core 模块优化（2-3 周）✅ 完成 ───────┤
  │   ├─ ✅ mcp.ts 拆分（1587→7 模块，最大 467 行）
  │   ├─ ✅ agent.ts 分解（806→3 模块，最大 404 行）
  │   └─ ✅ hooks.ts 拆分（755→3 模块，最大 476 行）
  │
  ├── v4.0 Phase 1（4-6 周）✅ 完成 ────────┤
  │   ├─ ✅ Plugin 运行时接口 + DefaultRuntime + RuntimeToolkit
  │   ├─ ✅ Plugin runtime 加载机制（createSession 自动装载）
  │   └─ ✅ 示例 runtime（audit / mcts）+ docs/RUNTIME.md
  │
  ├── v4.0 Phase 2（4-6 周）✅ 完成 ────────┤
  │   ├─ ✅ Agent Teams（runTeam）+ task 工具 team 模式
  │   ├─ ✅ team_message 事件 + ToolContext.emitEvent
  │   ├─ ✅ 共享 worktree + 文件级冲突检测
  │   └─ ✅ 三种合并策略 + docs/TEAMS.md
  │
  ├── v4.0 Phase 3（6-8 周）🔄 进行中 ──────┤
  │   ├─ ✅ WS 服务器（serve --web，token + origin 门禁）
  │   ├─ ✅ Web UI SPA（apps/web：聊天/diff/权限/会话）
  │   ├─ ⬜ 文件浏览器 + Monaco + xterm
  │   └─ ⬜ Slack Bot
  │
  └── v4.0 Phase 4（持续）⬜ 待启动 ────────┤
      ├─ Marketplace 平台
      ├─ 性能优化
      ├─ 安全加固
      └─ 模型支持扩展
```

---

## 七、风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| Plugin 运行时接口设计不当导致后续不兼容 | 高 — 需要 breaking change | Phase 1 只做接口定义 + DefaultRuntime 包装，不改变公共 API；收集社区反馈后再定稿 |
| Agent Teams 复杂度高 | 中 — 可能延期 | 先做最小可用版本（leader + 2 worker，无 specialist），验证协议后再扩展 |
| Web UI 工作量大 | 中 — 可能挤占其他任务 | 考虑复用 VSCode 扩展的 Webview 代码；或用现有 TUI 的 headless 模式 + 简单 Web 终端 |
| MCP 规范变更 | 低 — 已锁定 2024-11-05 版本 | 关注 MCP spec 更新，保持兼容性 |
| 模型 Provider API 变更 | 低 — 已有 fallback 机制 | 保持 provider 接口的抽象性，新增 provider 不影响核心 |
