# CodePilot 对标 Cursor 全能力差距分析报告

> 分析日期：2026-05-18（v6，Anthropic thinking + Share/BG 持久化感知）  
> 分析范围：插件端(`plugin/`)、WebUI(`plugin/webui/`)、后端(`backend/`)  
> 对照文档：`doc/00~16` + `docs/01~08`  
> 成熟度口径：**Designed → Implemented → Integrated → Productized**（见 [STATUS.md](./STATUS.md)）

---

## 一、总体状态概览

| 阶段 | 设计 | 实现 | 主链集成 | 用户可感知 |
|---|---|---|---|---|
| **P0 主链** | 100% | ~96% | **~90%** | **~78%** |
| **P1 高频** | 100% | ~94% | ~87% | ~75% |
| **P2 体验** | 100% | ~90% | ~85% | ~72% |
| **P3 差异化** | 100% | ~75% | ~58% | ~42% |

**核心结论**：P0 主链「能跑、能看、能审」已达标；本轮主攻 **会话成本/用量感知**、**Codebase→对话上下文**、**Background 云同步感知**。

**P0 已落地（集成→感知）**：
- v2 默认 + `ChatViewV2`；`session_messages` → `hydrateChatV2FromLegacyMessages`
- `shell.progress` / `tool.progress` 流式累积 → `ShellStepCard`
- `stageBeforeApply` 默认 `true`
- `AgentContentRenderer` + Plan 状态图标
- `sessionBridge` + `sessionUiStore`（App 会话/分支状态外提）
- **`session_cost`** + v2 **`turn.metrics`**（每轮 token/费用脚标）

**P1 本轮增量**：
- Memories **suggested 待审队列** + Rules Tab 角标
- `ActiveRulesPill` 接入 `rulesMemory` store
- Usage：`POST /v1/usage/record` + `GET /v1/usage/summary` 与本地合并 + **DB 角标**
- v2 历史 turn 保留 `contextRefs` 展示（`ContextRefChips`）
- Codebase 搜索结果 **Add to chat** → `context.add_ref`

---

## 二、设计差距（Designed but missing / 架构不符）

### P0

| # | 差距 | 状态 |
|---|---|---|
| D1 | 事件协议接管主链 | ✅ v2 默认；App ~230 行 + layout 组件 |
| D2 | Agent 全过程透出 | ✅ Graph + v2 step 树 |
| D3 | App.tsx 顶层布局 | ✅ `appBootstrap` + layout 组件；App ~240 行 |
| D4 | steps/content 共存 | ✅ ChatViewV2 富渲染 |

### P1

| # | 差距 | 状态 |
|---|---|---|
| D5 | @ 引用产品化 | ✅ InputBar % budget + breakdown；`contextBudgetTokens` 设置同步 |
| D6 | Marketplace | ✅ Registry E2E + 分页 + 安装错误 toast |

### P2–P3

| # | 差距 | 状态 |
|---|---|---|
| D7 | MCP 深度整合 | ✅ Graph `mcp.call` + 输入区 `McpActivityBanner`（v1/v2 统一）+ 执行前确认 |
| D8 | Usage/Quota | ✅ DB + quota API + WebUI `usage.set_quota` |
| D9 | Memories 审阅 | ✅ suggested 队列 + Tab 角标 |
| D10 | Background 云 API | ✅ PATCH + Flyway `V9` JDBC 主存（`background_agent_tasks`） |
| D11 | Share 云 | ✅ 远程优先 + Flyway `V9` JDBC 主存（`conversation_shares`） |
| D12 | Tab 模型化 | ✅ `FimSyncCompleter` + 来源统计（heuristics/fim/model） |
| D13 | Max/thinking provider | ✅ o-series `reasoningEffort` + Claude `thinking` extraBody（Spring AI 1.1.0 原生）+ `MaxModeHint` |
| D14 | Usage 持久化 | ✅ Flyway `V8__usage` + JDBC 主存（文件仅 fallback/导入） |
| D15 | VISION 校验 | ✅ WebUI + 插件双端拦截 |

---

## 三、实现差距（已有代码，集成/感知不足）

| # | 能力 | Integrated | Productized | 备注 |
|---|---|---|---|---|
| I1 | v2 协议 | ✅ | ✅ hydrate + turn.metrics | — |
| I2 | Hunk Apply | ✅ | ✅ staging 默认 | — |
| I3 | Shell 流式 | ✅ | ✅ | reducer + ShellStepCard |
| I4 | Inline Edit | ✅ IDE | ✅ IDE | — |
| I5 | Codebase | Tab + @ + add_ref | InputBar chips + 对话 ref 芯片 | — |
| I6 | Rules/Memories | 注入 + pill | Tab 待审队列 | — |
| I7 | MCP | Graph 运行时 | ✅ 输入区 banner + 确认门 | — |
| I8 | Background | worktree + 云 registry | Tab + 云角标 + **· DB/file** 副标题 | `GET /status` + JDBC `V9` |
| I9 | Export | Tab + 云 share | ExportPanel · DB（创建 + 面板 status） | `GET /v1/share/status` |
| I10 | Tab 预测 | IDE + API | IDE 启发式 + 后端 predict | `TabPredictionClient` |

---

## 四、最关键阻塞项（下一波）

1. ~~**App.tsx 瘦身**~~ — ✅ layout 拆分 + `appBootstrap`（App ~230 行）  
2. ~~**MCP 对话内来源**~~ — ✅ MCP banner + **执行前确认对话框**（`McpConfirmGate`）  
3. ~~**Share / Background 端到端**~~ — ✅ share 远程优先；bg 云 registry + **云端 cancel**  
4. ~~**@ 引用与 Context Budget**~~ — ✅ `context.estimate` + InputBar 预估提示  
5. **Marketplace Registry E2E** — ✅ WebUI `skill_*` → `SkillMarketplaceBridge` + `ThirdPartyRegistryClient`  
6. **App 壳层** — ✅ `appShellBridge`（IDE 主题同步）  
7. **global.css** — ✅ 去重至 ~3.4k 行  
8. **Context budget 闭环** — ✅ 设置项驱动 total + InputBar % + breakdown  
9. **MCP 对话条** — ✅ `McpActivityBanner`（待审批 + 本 turn MCP 工具）  
10. **Background 感知** — ✅ 轮询同步 + Tab 角标 + 云任务计数  
11. **Share 云端** — ✅ 绝对 URL、`source=cloud`、ExportPanel UX  
12. **VISION 校验** — ✅ `visionValidate` + 插件 `error` 40001  
13. **Max provider** — ✅ Max 模式升级 PREMIUM（含 vision）  
14. **Tab LLM** — ✅ `/v1/tab/predict` ChatClient 回退  
15. **Usage 持久化** — ✅ `UsagePersistenceStore`  
16. **Background 状态机** — ✅ PATCH + 插件双向同步  
17. **Share 只读查看** — ✅ `share.get` + `ShareViewer` Markdown 渲染  
18. **needs_input 主会话** — ✅ `needsInputStore` + `NeedsInputDock` + ChatViewV2 `NeedsInputCard`  
19. **Background needs_input** — ✅ `bg.respond` + 面板回复区（含 cloud）  
20. **Usage 配额 UI** — ✅ `usage.set_quota` → `POST /v1/usage/quota`  
21. **App 布局拆分** — ✅ `ChatMainArea` / `ChatInputSection` / `AppTabBar` / `appBootstrap`  
22. **Tab FIM 专用路径** — ✅ `FimSyncCompleter`；Tab 面板展示 `byPredictSource`  
23. **Max Graph 预算** — ✅ `PolicyChatOptions` + `GraphLlmHelper`（plan/generate/repair）  
24. **MCP 主链感知** — ✅ `mcpActivityStore`（legacy + envelope）+ 输入区 banner  
25. **Usage DB** — ✅ `V8__usage.sql`（`usage_records` / `usage_daily_quotas`）  
26. **Share/Background DB** — ✅ `V9__share_and_background.sql` + JDBC stores  
27. **会话成本感知** — ✅ `session_cost` + v2 `turn.metrics` + `SessionCostPanel`  
28. **分支树主会话** — ✅ v2 `BranchTimeline` + per-turn Fork + `switch_branch`  
29. **多模态历史** — ✅ 图片持久化 + v1/v2 `MessageImages` 回放  
30. **Anthropic thinking** — ✅ `ThinkingPolicyMapper.anthropicThinkingExtra` + `OpenAiChatOptionsComposer`（Spring AI 1.1.0 `extraBody`）  
31. **Share/BG 持久化感知** — ✅ `/v1/share/status` + `/v1/background-agents/status` → 插件 → 面板副标题 · DB/file  

---

## 五、后端差距（修订）

| API | 状态 |
|---|---|
| `/v1/conversation/*` Graph/SSE | ✅ |
| 发版 drain（`/actuator/drain` + Helm preStop + `deploy_draining`） | ✅ P2a |
| 跨 Pod 无感任务队列（DB worker） | ✅ P2b（V10 + reclaim + attach stream） |
| `/v1/actions/*`, `/v1/fim/*`, `/v1/mcp/*` | ✅ |
| `mcp.call` in Graph | ✅ |
| `/v1/share/*` | ✅ JDBC + `GET /status`（backend: db\|file） |
| `/v1/background-agents/*` | ✅ CRUD + PATCH + `GET /status` + JDBC |
| `/v1/usage/*` | ✅ record/summary/quota + JDBC |
| `/v1/tab/predict` | ✅ 启发式 → `FimSyncCompleter` → ChatClient |

---

## 六、实施路径（设计→实现→集成→感知）

| 波次 | 目标层 | 内容 |
|---|---|---|
| **当前** | 实现 | Spring AI 1.1.0 + Alibaba Graph 1.1.0.0（原生 `extraBody` + `KeyStrategyFactory`）已完成 |
| +2 周 | 感知 | Share/Background 管理端列表与过期清理 UI |
| +4 周 | 产品化 | 分支 diff 对比、图片 OCR 描述 |
