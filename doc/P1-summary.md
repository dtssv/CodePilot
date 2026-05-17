# P1 阶段总结(2026-05-17)

## 完成范围

P1-05 到 P1-08 已完成插件端、WebUI 端和后端/prompt 核查。

## Java / Prompt 变更说明

P1 主体实现主要发生在插件端,不是因为 Java 后端和 prompt 已经“天然完美”,而是
在 P0 后端审计修复批次中已经完成了 P1 所需的关键后端/prompt 基座:

- Java: `ActionController.java`、`ConversationRunRequest.java`、`PromptOrchestrator.java`
  已增加 `bareMode`、`useGraph`、inline-edit 上下文字段等能力。
- Prompt:已新增/重写 `rules.compile.txt`、`memory.distill.txt`、
  `action.inline-completion-fim.txt`、`apply.fast.txt`、`agent.background.txt`、
  `agent.edit-prediction.txt`、`share.summary.txt` 等模板。
- P1-05/P1-07/P1-08 的运行时动作发生在用户本机插件内,按安全和隐私原则不应
  把代码索引、MCP stdio 进程或 shell 命令迁移到 Java 后端。

仍未做的后端项属于 P2/P3 范围:如 `/v1/background-agents/*`、`/v1/share/*`、
服务端 fast-apply endpoint、RAG status contract cleanup 等。

| 项 | 插件端 | WebUI | 后端/prompt 结论 |
|---|---|---|---|
| P1-05 Codebase Index | `IndexScheduler` 暴露 `CodebaseStatus`、pause/resume/rebuild/search/ignore | `CodebasePanel` + `state/codebase.ts` | `/v1/rag/*` 已存在;本功能采用本地 PSI/TF-IDF 索引,无需上传代码 |
| P1-06 Rules + Memories | `RulesService` + `MemoryService`;active rules/memories 注入 `projectRules` | `RulesMemoryPanel` + `state/rulesMemory.ts` | `rules.compile.txt`、`memory.distill.txt` 已补齐 |
| P1-07 MCP + Hooks | `McpService` + `HookEngine`;`beforeSubmitPrompt/beforeShellExecution` 接入 | `McpHooksPanel` + `state/mcpHooks.ts` | MCP 本地运行,无需新增服务器端点 |
| P1-08 Shell Allowlist + Streaming | `ShellPolicy`;`ShellExecutor` policy/confirm/hooks/streaming | `ShellPolicyPanel` + `state/shellPolicy.ts` | `shell.generate.txt`/`guard.system.txt` 足够 |

## 新增/修改的关键文件

- `plugin/src/main/kotlin/io/codepilot/plugin/indexer/IndexScheduler.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/rules/RulesService.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/memory/MemoryService.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/mcp/McpService.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/hooks/HookEngine.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/shell/ShellPolicy.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/tools/ShellExecutor.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/toolwindow/CefChatPanel.kt`
- `plugin/webui/src/App.tsx`(新增 Codebase/Rules/MCP/Shell tabs)
- `plugin/webui/src/state/{codebase,rulesMemory,mcpHooks,shellPolicy}.ts`
- `plugin/webui/src/components/{codebase,rules,mcp,shell}/*.tsx`

## Bridge 端点

- `codebase.get_status/rebuild/pause/resume/search/set_ignore`
- `rules.reload/list/create`
- `memory.list/upsert/set_status/remove`
- `mcp.list_servers/reload/start/stop/set_granted/edit_config`
- `hooks.list/save`
- `shell.policy_get/policy_save`

## 事件

- `codebase.status`, `codebase.search.result`
- `rules.loaded`, `memory.update`
- `mcp.status`, `hook.result`
- `shell.progress`, `tool.progress`

## 验证情况

已对新增/修改文件运行 `ReadLints`,无 IDE 诊断错误。额外验证:

- `plugin`: `gradle compileKotlin` ✅
- `plugin/webui`: `npm run build` ✅(P1 面板已挂到 `App.tsx`)
- `backend`: `gradle :codePilot-api:compileJava :codePilot-core:compileJava` ✅

说明:`./gradlew.bat` 仍受本机 wrapper jar manifest 问题影响,因此使用系统
`gradle` 执行等价编译验证。

## 下一步建议

1. 做 `wireup`:在 `App.tsx` 挂载 `CodebasePanel`、`RulesMemoryPanel`、
   `McpHooksPanel`、`ShellPolicyPanel` 以及 P0 的 `ChangePanel`/Tab/Timeline。
2. CI 环境跑插件编译与 WebUI typecheck。
3. 进入 P2-09 会话分支树与 SessionSidebarV2。
