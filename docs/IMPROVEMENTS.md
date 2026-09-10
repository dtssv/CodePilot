# CodePilot 深化改造设计文档

> 参考项目：XiaomiMiMo/MiMo-Code、deepseek-ai/deepseek-harness、anomalyco/opencode、openai/codex、anthropics/claude-code。
> 本文档是差距分析 + 逐项设计。实施顺序按 P0 → P3。语言不变（TypeScript），只借鉴设计与实现。

## 0. 现状评估

CodePilot 已具备：分层 system prompt（静态前缀/动态后缀）、事件溯源 session（JSONL）、artifact 溢出、分层 compaction（fold + 小模型摘要）、checkpoint、双 tier 记忆、skills 渐进披露、MCP（stdio+SSE）、子代理、goal loop、协作模式（chat/plan/agent）、权限引擎、分层配置。

对照参考项目后的核心差距：

| 维度 | 参考项目做法 | CodePilot 现状 | 差距 |
|---|---|---|---|
| 工具描述 | claude-code/opencode 每个工具 100-500 词"使用说明书"（何时用/不用/禁忌/示例） | 多数工具 1-2 句 | 大 |
| read 输出 | claude-code/codex 均 `cat -n` 行号（`  312→code`） | 无行号 | 大 |
| edit | codex `apply_patch` 多 hunk；claude-code Edit 支持 `replace_all` + 先读后写强制 | 单点 search/replace，无先读约束 | 中 |
| bash | claude-code `run_in_background` + BashOutput/KillShell | 同步执行，60s-10min 超时 | 中 |
| web | claude-code WebFetch/WebSearch 标配 | 无（且 prompt 幻觉引用 web_fetch） | 大 |
| 权限规则 | claude-code `permissions.allow/ask/deny`，规则语法 `Bash(npm run test:*)`，deny 优先，"always" 按规则持久化 | 只有 autoApprove 列表；"always" → 全局 yolo（过宽） | 大 |
| 沙箱 | codex seatbelt/landlock 内核级隔离 | 无（文档化即可，不做内核级） | 文档 |
| 上下文 | opencode 每 turn 前 prune 旧 tool output（"micro-compaction"） | 只在阈值后整体压缩 | 中 |
| 记忆 | claude-code CLAUDE.md 沿目录树向上逐级加载（enterprise/user/project/local） | 只读 cwd 单文件 | 中 |
| 子代理 | claude-code Task 支持并行多代理 + agent 类型 | 单任务串行 | 小 |
| 错误处理 | 各家均为"工具错误即信息，回给模型自纠正" | Zod 校验失败静默放行 | 中 |

## 1. 工具系统（P0/P1）

### 1.1 read_file：行号 + 二进制检测

- 输出格式改为 `cat -n` 风格：`     1→<line>`（右对齐 6 位 + tab 语义分隔符 `→`，与 claude-code 一致；模型对 `file:line` 的定位依赖它）。
- `startLine`/`maxLines` 语义不变；截断时在头部标注 `(showing lines X-Y of N)`。
- 二进制检测：读前 8KB 含 `\0` 则判定二进制，返回提示（"binary file, <mime guess>; use bash `file` for details"），不倾倒字节。
- 空文件返回 `(empty file)`。

### 1.2 edit_file：多处编辑 + 强化约束

- 新增可选 `edits: [{search, replace, global_replace?, regex?}]` 数组；与顶层 search/replace 互斥。数组内按序应用，任一失败则整体不落盘（事务性），错误信息指明第几个 edit、用的哪种策略。
- 成功后返回变更统计：`applied N edit(s) to <path> (+a/-b lines)`。
- 保留现有 4 级匹配策略（exact → trimmed-lines → single-line → regex）。

### 1.3 bash：后台任务

- 新参数 `run_in_background: boolean`。后台任务：spawn 脱离等待，stdout/stderr 追加写入 `.codepilot/jobs/<jobId>.log`，元数据（pid、command、startedAt、status、exitCode）写 `<jobId>.json`。立即返回 `job_<id>`。
- 新工具 `bash_output(job_id, tail?)`：读状态 + 日志尾部（默认最后 100 行）；`bash_kill(job_id)`：SIGTERM。
- Job 注册表为模块级（按 cwd 隔离），进程退出时更新状态文件。
- 前台语义不变（超时、5MB 软上限、artifact 溢出）。

### 1.4 新工具：web_fetch / web_search

- `web_fetch(url, max_chars?)`：permission `network`。Node 原生 fetch，30s 超时，5MB 上限；`text/html` 做轻量剥离（script/style 去除、标签→空白、实体反转义、空白折叠）；结果 >8KB 溢出 artifact，返回头部 + ref。跟随重定向，记录最终 URL。
- `web_search(query, max_results?)`：permission `network`。零依赖走 DuckDuckGo HTML 端点，解析结果标题/URL/摘要；失败时返回明确错误（不静默）。这是尽力而为的免费通道，用户在意的搜索可配 MCP 搜索服务。

### 1.5 工具描述全面强化

参照 claude-code/opencode 的写法，每个工具 description 包含：功能一句话、何时用、何时**不**用（及替代工具）、参数要点、输出格式、注意事项/示例。例如 read_file 的行号格式说明、edit_file 的"必须先读"、bash 的"不要用 cat/sed 读写文件"。

### 1.6 glob/grep 默认排除

内建忽略清单（`.git`、`node_modules`、`dist`、`build`、`.next`、`target`、`__pycache__`、`.pnpm-store` 等），参数 `includeIgnored` 可关闭。避免在 monorepo 里返回数万噪声结果。

## 2. 权限系统（P1）

### 2.1 规则模型（claude-code 语法）

```jsonc
// .codepilot/config.json
{
  "permissions": {
    "allow": ["read_file", "bash(npm test *)", "bash(/^git (status|diff)/)", "mcp__github__*"],
    "ask":   ["bash(git push *)"],
    "deny":  ["bash(rm -rf *)", "bash(curl * | sh)"]
  }
}
```

- 规则形式：`tool`（整工具）、`tool*`（通配）、`tool(prefix *)`（对工具的"主参数"做前缀/通配匹配，bash→command，read_file/write_file/edit_file→path，web_fetch→url）、`tool(/regex/)`。
- 判定顺序：**deny > ask > allow > 模式默认**（ask/auto-edit/yolo 语义不变）。deny 在任何模式下生效（含 yolo），作为安全兜底。
- `autoApprove` 旧字段保留，等价并入 `permissions.allow`。

### 2.2 "always" 决策收窄

现状：用户点 always → `setMode("yolo")`（整个会话放开一切）。改为：把当次调用提炼为一条规则（如 `bash(npm test *)` 的前缀规则或工具名规则）加入 PermissionEngine 的会话级 allow 集；暴露 `PermissionEngine.addSessionRule(rule)` 与 `rules()`。持久化到 repo config 由上层（TUI/IDE）可选触发，引擎只提供 `persistRule(cwd, rule)` 帮助函数（读写 `.codepilot/config.json` 的 `permissions.allow`）。

## 3. Agent loop（P0/P1）

1. **Zod 校验失败回错**：`safeParse` 失败 → 返回 `isError: true` 的 tool_result，内容含具体字段错误（`input.path: Required`），让模型自我纠正，不再静默放行。
2. **provider 错误不执行工具**：本 turn 若 `sawError`，跳过已收到的 tool calls（可能是残缺输入），发 error 事件并结束本轮。
3. **maxTurns 可配**：`config.maxTurns`（默认 50），schema 同步。
4. **Turn 级微压缩**（opencode prune 思路）：构造 provider messages 前对历史做无损 fold——把最近 N=8 条消息之前的 `tool_result` 折叠为 stub（复用 `compaction.foldToolResults`，只作用于发送副本，不改持久化事件）。显著降低长任务每 turn 的输入 token。
5. **steering**：`Session.steer(text)` 在 agent 运行中注入一条 user 消息；loop 每 turn 开始前 drain 队列追加进 transcript。用于"边跑边补充约束"。

## 4. 记忆（P2）

- **层级加载**：从 `cwd` 向上逐级（直到 home 或 git root 之上）收集 `CODEPILOT.md`；同时识别 `AGENTS.md`（codex 惯例）作为 project memory 的补充源。动态后缀的 `<memory>` 块按路径标注来源，近处优先。
- 写入语义不变（`memory_write` 只写 cwd 的项目记忆或用户记忆）。

## 5. System prompt（P2）

- 修复幻觉引用（web_fetch 现在有真实实现；chat 模式白名单同步）。
- 新增 **§任务完成判定**：完成定义（deliverable 落盘 + 验证命令通过 + 总结报告所跑命令）；"不要为讨好用户而提前声明完成"。
- 新增少量 **few-shot 行为示例**（一个 edit 流程、一个测试失败迭代），控制静态前缀 ≤ ~6k tokens。
- 工具清单从"裸名字列表"升级为带一句话用途的列表（从 ToolDef.description 首句提取）。

## 6. 已实施 vs 后续路线

**本轮已实施**（详见各模块代码注释与 docs/CONFIG.md）：
- 工具系统：read_file 行号/二进制检测/行长截断，edit_file 事务性多 edit，bash 后台任务（bash_output/bash_kill），web_fetch/web_search，glob/grep 默认忽略重目录，全部工具描述强化为"何时用/不用/禁忌"格式。
- 沙箱（双层，三平台）：进程层 macOS Seatbelt / Linux bwrap / Windows WSL+bwrap，fail-closed 默认；工具层路径守卫（含 realpath 符号链接逃逸检测）跨平台生效；危险命令静态扫描在任何模式下强制询问。
- 权限：claude-code 语法 allow/ask/deny 规则（deny 绝对优先），"always" 收窄为会话级规则，persistRule 可持久化到 repo config。
- Agent loop：Zod 校验失败回错、provider 错误不执行残缺工具调用、maxTurns 可配、turn 级微压缩（fold 旧 tool_result）、steering 运行中注入。
- 记忆：CODEPILOT.md/AGENTS.md 沿目录树向上层级加载。
- System prompt：任务完成判定、行为 few-shot、工具清单带摘要、修复 web_fetch 幻觉引用。

**后续路线**（已评估，未实施）：
- MCP Streamable HTTP transport（现有 stdio+SSE 覆盖主流）。
- checkpoint 结构化 rewind（git worktree 快照，opencode 风格 revert）。
- task 子代理类型系统与结构化 schema 输出。
- Windows 原生进程沙箱（Job Objects 需原生模块；当前 WSL 后端 + fail-closed 兜底）。

## 7. 测试与验证计划

- 单测：permissions 规则矩阵、edit_file 多 edit 事务性、read_file 行号/二进制、bash 后台生命周期、web_fetch HTML 剥离（本地 http server）、记忆层级加载、微压缩 fold、Zod 错误回传。
- 回归：`pnpm -r build` + `pnpm test`（core/protocol）全绿。
- 文档：README/docs 同步新增工具与配置说明。

## v4 批次（已实施）

- `hooks.ts`：`HookEngine` 支持 PreToolUse / PostToolUse / Notification / Stop；exit 2 阻断工具调用，PostToolUse stdout 作为反馈追加到工具结果。
- `tools/ask_user.ts`：`ask_user_question`（多问题、可选项、multiSelect）+ `plan_done`（计划审批 → `mode_request` 事件 → 自动切到 agent 模式）。宿主通过 `SessionOptions.onAskUser` 接入。
- `tools/task.ts`：并行 fan-out（`tasks: [{objective, agent_type, tools, model, maxSteps}]`），`explore`（只读）/`worker`（可写）两种子代理类型。
- `mcp.ts`：`McpHttpClient`（Streamable HTTP / MCP 2025-03-26）—— 单端点 POST、`mcp-session-id` 会话头、JSON 或 SSE 响应、DELETE 结束会话；配置 `{"type":"http","url":...}`。
- `redact.ts`：工具结果统一脱敏（PEM 私钥、AWS/GitHub/OpenAI/Anthropic/Slack token、bearer、连接串密码、env/JSON 密值），agent loop 在回显与持久化前调用。
- `providers/fallback.ts`：`FallbackProvider` 有序 failover 链，仅在未产出内容且错误为瞬态时切换；`config.fallbacks`。
- `tokens.ts`：`estimateCostUSD` 公开价目表 + `session.getUsage()` 累计 token 与估算成本。
- `Event` 新增 `mode_request` 变体，TUI reducer 已同步。

### 待做（下一批次建议顺序）

~~1. TUI 问题 UI~~ **已完成**：`QuestionBridge`（参照 PermissionBridge）+ `QuestionPrompt` 组件（编号选项/键位选择/自由文本），`cli.tsx` 接 `onAskUser`。
~~2. IDEA 插件~~ **已更新接口**：`question/request` 对话框（选项单选/多选 checkbox/自由文本），修正 `permission/respond` 为 request 语义并补 reverse-request ack（协议要求双重回复）；未本地重编译（Kotlin/Gradle）。
~~3. 工具清单~~ **已补**：README「内置工具」一节。
~~4. 协议层 question RPC~~ **已完成**：`question/request`（server→client 反向请求）+ `question/respond`，`pendingQuestions` 注册表，shutdown 时 fail-closed 空 answers；VSCode 客户端接 `questionRequest` 事件 + QuickPick/InputBox 顺序询问。

**新增后续路线**：
- IDEA 插件 Gradle 重编译验证（本环境无 Gradle）。
- TUI/VSCode 端 `task` 工具并行子任务的可视化（当前以 tool_result 文本呈现）。
