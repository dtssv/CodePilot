# 16 — 对标 Cursor 的能力收敛路线图

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> 目标：把 `CodePilot` 从“能力很多、主链略分散的工程型产品”收敛成“主路径稳定、过程可见、变更可审阅、上下文可信、默认行为正确”的 Cursor 级 JetBrains AI 编程体验。
>
> 本文不是能力清单，而是 **优先级路线图**。核心原则是：
> **先统一主链路，再补高频体验，最后做高级差异化能力。**

---

## 1. 结论摘要

当前仓库的状态更接近：

- **架构潜力已具备**：Graph、SSE、ToolDispatcher、本地索引、Inline Edit、会话恢复、隐私/审计都已有基础。
- **产品主链仍未完全收口**：`plugin/webui/src/App.tsx` 仍承载大量 legacy 状态逻辑；结构化事件协议已落地基础设施，但未接管主界面；Graph 过程并非每一步都稳定展示给用户。
- **高阶能力分布不均**：Codebase Index、Rules、Shell、Model Router、MCP、Background Agents、Share/Export 等能力存在明显“设计 > 实现 > 产品接入”的断层。

因此，对标 Cursor 的最优顺序不是继续横向堆功能，而是：

1. **P0：统一主链路，做出“稳定、可见、可审阅”的第一感觉**
2. **P1：补齐高频工作流，让用户开始把它当主力工具**
3. **P2：做高级能力与生态闭环，形成真正的平台差异化**

---

## 2. 路线图设计原则

### 2.1 优先做“用户能马上感知到”的差距

优先级判断不以“底层是否已经有类/服务”决定，而以以下问题决定：

- 用户是否知道 Agent 现在在做什么？
- 用户是否敢让 Agent 改代码？
- 用户是否能看见和控制命令执行？
- 用户是否理解为什么它读了这些上下文、选了这个模型、提出了这些改动？

### 2.2 新能力必须建立在统一事件协议上

凡是以下能力，都不应继续基于 `App.tsx` 的 legacy 拼装逻辑扩张：

- Agent 步骤展示
- Diff staging / apply review
- Shell 流式输出
- Background tasks
- Usage / Quota
- Share / replay

否则只会继续积累状态分叉与渲染不一致。

### 2.3 先完成“主路径闭环”，再做“生态扩展”

优先顺序应为：

- Chat / Agent / Diff / Shell / Codebase / Rules
- 然后才是 Background Agents / Share / Marketplace 深度整合 / Memories

### 2.4 文档状态必须区分三层

后续每个阶段都应明确区分：

- **已实现（Implemented）**
- **已接主流程（Integrated）**
- **可被用户稳定感知（Productized）**

避免继续出现“代码里有类/文档里有设计，就被统计成已完成”的情况。

---

## 3. 三阶段总览

| 阶段 | 核心目标 | 用户感知变化 | 结果判断 |
|---|---|---|---|
| **P0 — 主链统一** | 把 Chat/Agent 主路径变成稳定的结构化事件流，补齐步骤可视与变更审阅 | “它终于像一个成熟 Agent 了” | 开始具备 Cursor 的第一印象 |
| **P1 — 高频体验补齐** | 把 Codebase、Rules、Model Auto、@ 引用、会话导航做完整 | “它开始像我的主力编码工具了” | 日常工作流接近 Cursor |
| **P2 — 高级能力与生态** | 做 Background Agents、Share/Export、Memories、MCP 深度闭环 | “它不只是像 Cursor，还有 JetBrains 场景的扩展能力” | 形成高级差异化 |

---

## 4. P0 — 主链路统一与第一感知提升

> 目标：让用户第一次上手时，明显感受到它是一个**稳定、过程可见、改动可审阅、命令可控制**的 AI 编程产品。

---

### P0-1. 让结构化事件协议真正接管主聊天链路

**优先级：P0 / #1**

#### 为什么先做

当前主聊天 UI 仍主要依赖：

- `activeReplyRef`
- `activeTurnIdRef`
- `upsertTurnAssistant`
- 20+ 个 legacy `onPluginEvent(...)`

这直接导致：

- 流式过程展示靠前端猜测归属
- 中间态 `done.reason`、resume、replan 容易不一致
- Agent step、tool call、plan、delta 很难形成稳定的结构化视图
- 后续新能力（shell stream、pending apply、background tasks）难以自然接入

#### 直接目标

把 `doc/01-event-protocol.md` 中的 v2 事件协议切为主链：

- `turn.start` / `turn.end`
- `step.start` / `step.progress` / `step.end`
- `text.delta`
- `tool.call` / `tool.progress` / `tool.result`
- `plan.update`
- `needs_input`
- `risk_notice`
- `replay_since`

#### 重点涉及文件

- `plugin/webui/src/App.tsx`
- `plugin/webui/src/state/chatStore.ts`
- `plugin/webui/src/state/turnReducer.ts`
- `plugin/webui/src/state/events.ts`
- `plugin/src/main/kotlin/io/codepilot/plugin/protocol/EventBus.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/protocol/LegacyEventAdapter.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/toolwindow/CefChatPanel.kt`

#### 交付要求

1. `App.tsx` 不再负责 turn/assistant 拼装。
2. Chat 主视图改为从 v2 store 读取 turn/step 树。
3. legacy 事件监听只保留兼容层，不再是主渲染来源。
4. gap 检测与 `replay_since` 真正用于缺包恢复。
5. `done(final/failed/stopped/max_steps)` 与 `session_interrupted` 统一映射到 turn 终态。

#### 验收标准

- 关闭网络后恢复时，前端可基于 `lastSeq` 补包并恢复一致状态。
- 同一个 turn 内的计划、工具、delta、风险提示、提问都能稳定归属到正确 step。
- 切 session / branch / resume 时，不再依赖 `App.tsx` ref 清理避免串台。

---

### P0-2. 把 Agent 全过程真正展示出来

**优先级：P0 / #2**

#### 为什么先做

当前虽然有 `agent_thinking / agent_reading / agent_writing / agent_running`，但还远不够：

- `graph_*` 事件多数只被插件内部消费
- `user_plan_progress` 目前未接主 UI
- `agent_running` 语义链路不完整
- 有 `content` 时 `agentSteps` 会被隐藏
- resume / replan 分支的事件覆盖不一致

结果是：

> 后端在跑 Graph，但用户只能看到部分过程，不像 Cursor 那样“持续知道它在干什么”。

#### 直接目标

让用户可以持续看到：

1. 计划
2. 读取
3. 生成/写入
4. 应用变更
5. 运行命令
6. 验证结果
7. 修复/完成

#### 重点涉及文件

- `plugin/webui/src/App.tsx`
- `plugin/webui/src/components/ChatView.tsx`
- `plugin/src/main/kotlin/io/codepilot/plugin/toolwindow/CefChatPanel.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/conversation/ConversationClient.kt`
- `backend/codePilot-core/src/main/java/io/codepilot/core/graph/actions/*.java`

#### 建议动作

1. 前端接入 `user_plan_progress` 并更新 plan steps。
2. 把 `graph_verify`、`graph_phase_done`、`graph_repair_plan`、`graph_budget_alert` 中对用户有价值的摘要透出到 UI。
3. `ChatView` 改为允许 `planSteps + agentSteps + content + tool cards` 共存，不再互斥隐藏。
4. 统一 run / resume / replan 三条 listener 的事件覆盖面。
5. 为 verify / repair / phase done 提供统一 step card 语义。

#### 验收标准

- 一次完整 Agent 执行中，用户能连续看到从分析到完成的各阶段。
- `user_plan_progress` 能真实映射为 plan 状态变化。
- 过程步骤不会在最终正文出现后完全消失。
- resume 继续执行后，步骤时间线连续而不是“重新开一条黑箱回复”。

---

### P0-3. 把 AI 改动从“待变更列表”升级为正式审阅流

**优先级：P0 / #3**

#### 为什么先做

当前主界面中的写盘交互仍偏粗糙：

- 主要是“待变更文件”列表
- 只有“全部应用 / 清除列表”
- 与 Cursor 的逐文件 / 逐 hunk Accept/Reject 差距很大

而“用户是否敢用它改代码”，几乎完全取决于这条链路。

#### 直接目标

基于 `doc/03-apply-workflow.md` 建立完整流程：

- staged pending file
- per-file review
- per-hunk Accept / Reject
- apply file / apply all
- undo current AI turn
- reapply / smart realign

#### 重点涉及文件

- `plugin/src/main/kotlin/io/codepilot/plugin/tools/PatchApplier.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/tools/PatchRecorder.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/tools/SmartMatcher.kt`
- `plugin/webui/src/components/MultiFileDiffPanel.tsx`
- `plugin/webui/src/App.tsx`
- 新增：`plugin/webui/src/components/apply/*`

#### 建议动作

1. 将当前 `pendingChanges` 从“文件名列表”提升为“文件 + hunks + 状态”的正式状态模型。
2. UI 支持单 hunk 接受/拒绝。
3. UI 支持“本轮 AI 改动一键撤销”。
4. 写盘失败或外部修改漂移后，支持 reapply / 重新对齐。
5. 把风险等级与 auto-apply 策略并入 staged apply 流程，而不是孤立开关。

#### 验收标准

- 同一文件多个 hunk 可以分别接受/拒绝。
- 最终落盘内容只包含用户接受的 hunk。
- 用户能一键撤回本轮 AI 修改。
- 文件在外部被改动后，系统能重新对齐补丁，而不是直接失败或覆盖外部变更。

---

### P0-4. 让 Shell 成为第一等产品能力

**优先级：P0 / #4**

#### 为什么先做

Cursor 级 Agent 必须具备：

- 可以执行命令
- 用户知道它在执行什么
- 用户能看到输出
- 用户能阻止危险行为
- 用户能中止长任务

当前 CodePilot 已有终端底座，但用户侧缺完整闭环。

#### 直接目标

落实 `doc/08-shell-allowlist.md` 的最小闭环：

- 危险命令确认
- stdout/stderr 流式回显
- Stop 按钮
- 命令允许/拒绝原因提示
- shell result 以 step card 形式展示

#### 重点涉及文件

- `plugin/src/main/kotlin/io/codepilot/plugin/tools/TerminalSessionManager.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/tools/ToolDispatcher.kt`
- `plugin/src/main/kotlin/io/codepilot/plugin/tools/ReadOnlyShellGuard.kt`
- `plugin/webui/src/components/AgentStepCard.tsx`
- 新增：`plugin/webui/src/components/shell/*`
- `plugin/webui/src/components/ChatView.tsx`

#### 建议动作

1. 对 `shell.exec` / `shell.session` 做统一 step 展示。
2. 危险命令先用最小确认对话接入，不必等完整 policy editor 才上线。
3. 输出要实时出现在 UI，不等待命令结束才一次性展示。
4. 允许用户从卡片中直接 Stop。

#### 验收标准

- `git status` 可直接执行并实时显示输出。
- `npm install` / 带重定向命令默认 ask。
- 用户能从 UI 中止长命令。
- stdout / stderr / exitCode / duration 都可见。

---

### P0-5. 把 `App.tsx` 收口成“顶层布局组件”

**优先级：P0 / #5**

#### 为什么先做

`plugin/webui/src/App.tsx` 当前过重，会阻碍以下所有事情：

- 新协议接入
- 功能模块拆分
- 测试
- 多条主链并存（chat / composer / background / shell / codebase）

#### 直接目标

让 `App.tsx` 只负责：

- layout
- tab / page 容器
- 顶层挂载（auth/theme/route）

让以下内容下沉：

- chat state
- session state
- pending changes
- console state
- event → UI projection 逻辑

#### 验收标准

- `App.tsx` 不再直接承载完整对话状态机。
- 聊天、变更、终端、索引等都有独立 store/host。
- 事件处理逻辑不再是一个 `useEffect` 里堆叠的大量 listener。

---

### P0 阶段完成标准

满足以下 5 条即可判定 P0 完成：

1. Chat/Agent 主路径已由结构化事件驱动。
2. Agent 每一步都能稳定展示，不再靠 legacy 启发式推导。
3. 多文件改动支持正式审阅与回滚。
4. Shell 命令支持流式输出与停止。
5. `App.tsx` 不再是主状态总控器。

---

## 5. P1 — 高频工作流补齐

> 目标：在主链稳定后，把日常高频体验补齐，让用户真正愿意把它当成主力编码助手。

---

### P1-1. 把 Codebase Index 做成可见、可控、可信的产品能力

**优先级：P1 / #1**

#### 当前问题

本地检索引擎基础不错：

- `plugin/src/main/kotlin/io/codepilot/plugin/indexer/LocalSearchEngine.kt`
- `AdaptiveDepthSearcher.kt`
- `LocalEmbeddingService.kt`

但用户不知道：

- 是否已完成索引
- 当前索引进度如何
- 搜索结果从哪里来
- 如何重建 / 暂停 / 配置 ignore

#### 直接目标

落实 `doc/05-codebase-index.md`：

- `CodebasePanel`
- 索引状态 / 进度 / 失败数 / 上次完成时间
- rebuild / pause / resume
- ignore 规则配置
- `codebase.search.result` 卡片化展示

#### 重点涉及文件

- `plugin/src/main/kotlin/io/codepilot/plugin/indexer/*`
- `plugin/webui/src/components/codebase/*`
- `plugin/webui/src/InputBar` / 上下文区
- `plugin/webui/src/state/*`

#### 验收标准

- 用户能看到索引状态，不再是黑盒。
- `@Codebase` 的结果能作为卡片查看并固定到上下文。
- ignore 规则变更后可触发重建。

---

### P1-2. 把 Rules / `AGENTS.md` 真正接入主界面与主流程

**优先级：P1 / #2**

#### 当前问题

已有 `ProjectRulesLoader.kt`，但缺失明确的产品层：

- Rules 面板
- 激活规则的可见性
- `AGENTS.md` 的显式状态
- `.mdc` 规则体系的管理入口

#### 直接目标

落实 `doc/06-rules-memories.md` 的 Rules 部分：

- `RulesPanel`
- active rules pill
- `.codepilot/rules/*.mdc`
- `AGENTS.md` 自动注入与展示
- 当前 turn 激活规则可见化

#### 重点涉及文件

- `plugin/src/main/kotlin/io/codepilot/plugin/context/ProjectRulesLoader.kt`
- 新增：`plugin/src/main/kotlin/io/codepilot/plugin/rules/*`
- 新增：`plugin/webui/src/components/rules/*`
- `plugin/webui/src/App.tsx`

#### 验收标准

- 不同文件类型打开时，规则可自动激活。
- 顶栏可显示当前激活规则数量。
- 规则可增删改，并在下一轮对话立即生效。

---

### P1-3. 把模型选择升级为 `Auto + Max + 可解释路由`

**优先级：P1 / #3**

#### 当前问题

当前模型层更多是：

- 手动选择模型
- 查看总成本

而 Cursor 级体验要求：

- Auto 默认正确
- Max 是清晰心智
- 路由结果和理由是可见的

#### 直接目标

落实 `doc/11-model-router.md` 的最小可用版本：

- `auto` 成为默认或显性选项
- 路由结果回显：例如 `Auto → thinking model`
- `Max` toggle
- 最小版路由理由展示

#### 重点涉及文件

- `plugin/webui/src/components/ModelSelector.tsx`
- `plugin/webui/src/App.tsx`
- 新增：模型路由 service / usage state
- 后端或插件侧模型目录与能力归类逻辑

#### 验收标准

- 用户可直接选择 `Auto`。
- 简单请求默认走快模型，复杂请求自动走高推理/大上下文模型。
- 打开 `Max` 后，模型选择行为与 token/cost 展示有可见变化。

---

### P1-4. 把 `@` 引用系统产品化

**优先级：P1 / #4**

#### 当前问题

上下文能力虽然不少，但用户仍缺少：

- 命中透明度
- 来源可见性
- 预算影响可见性
- pin/unpin 的统一交互

#### 直接目标

落实 `/` 与 `@` 的统一输入体验：

- `@Codebase` / `@Docs` / `@Web` / `@Terminal` / `@Notepad` 结果卡片化
- 中文标点兼容修复
- 选中后展示来源、范围、token 影响
- pin/unpin 统一交互

#### 重点涉及文件

- `plugin/webui/src/components/InputBar.tsx`
- `plugin/webui/src/components/ContextChip.tsx`
- `plugin/webui/src/components/codebase/*`
- 引用解析侧 Kotlin provider

#### 验收标准

- 各类 `@` 引用的触发、选择、展示、固定交互一致。
- 用户始终知道当前 prompt 携带了哪些上下文。

---

### P1-5. 会话 / 分支 / 历史搜索增强

**优先级：P1 / #5**

#### 当前问题

已有 session / branch / fork 基础，但作为日常工作流还不够顺手：

- Sidebar 缺搜索与分组
- 分支是功能存在，不是心智存在
- 历史导航与跨会话检索能力弱

#### 直接目标

- SessionSidebar 搜索
- 时间/项目分组
- 分支树可视化
- 跨会话消息搜索

#### 验收标准

- 用户能快速找到历史会话与分支。
- 分支不再只是下拉框中的一串 ID。

---

### P1 阶段完成标准

满足以下 5 条即可判定 P1 完成：

1. Codebase 索引状态与搜索结果可见、可操作。
2. Rules / `AGENTS.md` 已成为主流程中的显式能力。
3. Model Auto/Max 成为可理解的产品能力。
4. `@` 引用成为统一的上下文系统而非零散入口。
5. 会话与分支导航明显提升日常可用性。

---

## 6. P2 — 高级能力与生态闭环

> 目标：在核心体验成熟后，补齐高级能力，形成真正的平台差异化，而不是继续堆积局部能力点。

---

### P2-1. Background Agents / worktree 隔离

**优先级：P2 / #1**

#### 为什么重要

这是最接近 Cursor 高级差异化体验的能力之一：

- 后台并行执行
- 独立 worktree
- 任务日志与状态
- 完成后合并回主工作区

#### 为什么必须放到 P2

如果 P0/P1 未完成，Background Agents 会放大所有已有问题：

- 事件协议不统一 → 后台任务更难展示
- diff 审阅不成熟 → 合并更危险
- shell 流式未收口 → 后台日志更黑盒

#### 直接目标

落实 `doc/13-background-agents.md`：

- `BackgroundTaskManager`
- worktree 创建/清理
- 独立 session
- 任务面板
- merge back

#### 验收标准

- 一个后台任务等于一个 worktree + 独立 session。
- 可并行、可取消、可打开 worktree、可 squash merge 回主分支。

---

### P2-2. Share / Export / PR Description

**优先级：P2 / #2**

#### 目标

落实 `doc/14-share-export.md`：

- Markdown 导出
- JSON replay 导出
- PR description 生成
- PII scrub
- 可选 share-service 链接

#### 验收标准

- 当前会话可导出为 Markdown / JSON / PR 描述。
- 导出前自动脱敏常见路径与 secret 模式。

---

### P2-3. Memories / 长期记忆审阅闭环

**优先级：P2 / #3**

#### 目标

落实 `doc/06-rules-memories.md` 的 Memories 部分：

- pending / accepted / rejected
- 可编辑
- 仅 accepted 注入 prompt
- 与 Rules 分层清晰

#### 注意事项

这项能力必须审慎推进：

- 自动提取容易误判
- 若过早上线，用户会迅速失去信任
- 必须默认“可审阅、可拒绝、可解释”

---

### P2-4. MCP / Marketplace / Skills 深度整合

**优先级：P2 / #4**

#### 目标

不是仅保留 Marketplace 面板，而是把 MCP/Skills 真正接入对话主流程：

- 工具发现
- 权限控制
- 调用链路解释
- 结果渲染
- registry / package 生命周期可见

#### 验收标准

- 用户能明确看到某个工具来自哪个 MCP/Skill 包。
- 工具安装、启停、调用、失败排查都可见。

---

### P2-5. Usage / Quota / 成本与配额治理

**优先级：P2 / #5**

#### 目标

在 `SessionCostPanel` 之上继续做：

- 按模型聚合
- 按天聚合
- 按 session/turn 聚合
- quota 警告与阻断
- Max 模式成本提示

#### 验收标准

- 用户知道哪些模型最贵、哪类任务最耗、何时接近额度上限。

---

### P2 阶段完成标准

满足以下 4 条即可判定 P2 完成：

1. Background Agents 可在独立 worktree 中稳定运行。
2. 会话可以导出、分享、复盘。
3. Memories 与 Rules 形成长期行为一致性体系。
4. MCP / Marketplace / Usage 构成完整生态与治理闭环。

---

## 7. 全局优先级排序（跨阶段）

以下是按“**最能快速接近 Cursor 感知体验**”排序的前 10 项：

| 排名 | 事项 | 阶段 | 价值说明 |
|---|---|---|---|
| 1 | 结构化事件协议接管主链路 | P0 | 一切体验统一的基础 |
| 2 | Agent 全过程可视化补齐 | P0 | 直接提升“像 Cursor”的过程感 |
| 3 | 多文件 Diff / hunk 审阅 / undo turn | P0 | 建立对 AI 改代码的信任 |
| 4 | Shell 流式输出 + Stop + 最小确认流 | P0 | 核心高频操作可控化 |
| 5 | `App.tsx` 去中心化、顶层收口 | P0 | 解除后续所有演进瓶颈 |
| 6 | Codebase Index 状态面板与结果卡片 | P1 | 代码库理解体验产品化 |
| 7 | Rules / `AGENTS.md` / active rules | P1 | 项目长期一致性关键能力 |
| 8 | Auto Model Routing + Max | P1 | 把模型选择升级为产品能力 |
| 9 | `@` 引用系统产品化 | P1 | 上下文透明度与控制力提升 |
| 10 | 会话搜索 / 分支树 / 历史增强 | P1 | 日常效率提升与历史可回溯 |

---

## 8. 暂缓项（避免分散资源）

以下事项不建议抢在 P0/P1 之前推进：

### 8.1 Background Agents

虽然价值高，但前置依赖太多；在主链未统一前推进，只会把现有状态问题放大。

### 8.2 Share / Export

这是成熟化能力，不是“第一感觉像 Cursor”的决定项。

### 8.3 Memories 自动提取

如果 Rules、上下文、事件协议、过程展示还没稳，记忆系统只会增加不确定性。

### 8.4 复杂 Marketplace / Registry 打磨

在对话主路径还未完全收口前，继续横向扩生态会稀释核心体验投入。

---

## 9. 建议排期方式

### 第一波（4~6 周）—— 做出“像 Cursor 的第一感觉”

1. 结构化事件协议接管主链
2. Agent 步骤展示补齐
3. `user_plan_progress` 接入主 UI
4. `ChatView` 改为 steps/content 共存
5. staged diff / hunk review / undo turn
6. shell 流式输出 + stop
7. `App.tsx` 逻辑下沉

### 第二波（4~8 周）—— 补齐日常高频工作流

1. CodebasePanel
2. Codebase search result card
3. RulesPanel + active rules pill
4. `AGENTS.md` 接入可见化
5. Auto model routing + Max
6. `@` 引用系统统一卡片化
7. Session 搜索 + 分支树

### 第三波（8 周+）—— 建立高级能力与平台差异化

1. Background Agents + worktree
2. Share / Export
3. Memories 审阅闭环
4. MCP / Marketplace 深度融合
5. Usage / Quota 完整仪表盘

---

## 10. 每阶段成功定义

### P0 成功定义

用户会明确感受到：

- Agent 会持续展示自己在做什么
- 代码改动是可审阅、可回滚的
- 终端输出是可见、可停、可控的
- 恢复与多轮过程不再混乱

### P1 成功定义

用户会开始把它当成主力工具，因为：

- 它真的理解整个代码库
- 它真的遵循项目规则
- 它会自动选择合适模型
- 它的上下文系统是透明的

### P2 成功定义

用户会觉得它不只是“像 Cursor”，而是：

- 有更强的 JetBrains / worktree / 本地工程集成能力
- 可以作为团队协作与长期知识沉淀工具使用

---

## 11. 如果资源极其有限，只先做这 3 件事

若当前只能投入很有限的人力，建议优先做：

1. **结构化事件协议切主链**
2. **Agent 全过程可视化**
3. **Diff/hunk 审阅 + undo turn**

这 3 件事叠加后，用户会最快感知到以下变化：

- 它是稳定的
- 它不是黑箱的
- 它不会乱改代码
- 它明显更像 Cursor

---

## 12. 文档维护建议

为避免后续再次出现“能力很多但状态不透明”的问题，建议从本路线图开始建立统一的状态标签：

- `✅ Implemented`：代码已存在
- `🔗 Integrated`：已接入主产品链路
- `✨ Productized`：用户可稳定感知
- `🧪 Experimental`：仅灰度或局部启用
- `📝 Designed`：仅设计，未实现

同时建议在每个专项文档顶部增加：

- 当前状态
- 依赖的前置阶段
- 主链接入情况
- 验收入口

这样 `/doc` 与 `/docs` 才能真正成为一套“可执行、可验收、可持续维护”的产品文档体系。

