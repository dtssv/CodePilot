# CodePilot WebUI 与 Cursor 能力对齐 — 总设计

## 0. 文档说明

本套设计基于对 `plugin/webui/src/App.tsx` 及其事件流、Kotlin 侧
`plugin/src/main/kotlin/io/codepilot/plugin/**` 现有能力的盘点,目标:**将 WebUI
体验对齐 Cursor 当前形态**。每个子文档都给出可直接编码落地的接口、组件、
事件契约,不留空实现。

## 1. 当前架构速览

```
┌──────────────────────────────────────────┐
│  JCEF WebUI (React, src/App.tsx)         │
│  - InputBar / ChatView / ToolCallCard    │
│  - Panels: Composer/Marketplace/Notepads │
└──────────────┬─────────────▲─────────────┘
               │ cefQuery    │ __codepilot_dispatch
               ▼             │
┌──────────────────────────────────────────┐
│  Kotlin Plugin Host                       │
│  - ConversationClient  (SSE → events)     │
│  - ToolDispatcher      (fs.* / shell.*)   │
│  - SessionStore        (持久化)            │
│  - McpProcessManager   (MCP)              │
│  - AtReferenceProvider (@ ref)            │
│  - InlineCompletionProvider               │
└──────────────────────────────────────────┘
```

WebUI 与 Plugin 间的通道在 `plugin/webui/src/bridge.ts`:

- Web → Plugin:`sendToPlugin(type, payload)` → `cefQuery`
- Plugin → Web:`window.__codepilot_dispatch(type, payload)`

## 2. 与 Cursor 的差距(摘要)

| 类别 | 缺失 | 体验欠佳 |
|---|---|---|
| Inline UX | Cmd+K 内联编辑、Tab 预测、Ghost text | 选中后只能 Add to Chat |
| Apply 工作流 | hunk 级 Accept/Reject、Undo all AI | 仅"全部应用" |
| @ 引用 | @Lint / @Recent / @Definitions / @PastChats | @Web/@Docs/@Codebase 索引状态不可见 |
| Rules / Memories | `.cursor/rules`、长期记忆 | Notepads 已过时 |
| MCP / Hooks | MCP 管理 UI、Hooks 配置 | Marketplace 定位不清 |
| Shell | 运行前确认、流式输出、allowlist | 一次性下发 |
| 多 Agent | 并行任务 / Background Agents | 仅对话分支 |
| 事件协议 | sequence id、结构化 step 树 | 前端 ref 拼装 turn |
| 工具卡片 | result 回传、参数展开、重跑 | 仅 status 三态 |
| 内联补全 | UI 反馈、接受率统计 | 后端 Provider 已存在 |

## 3. 优先级路线图

| 阶段 | 周期(估) | 包含 |
|---|---|---|
| **P0 — 基础重构** | 2 周 | `01-event-protocol`、`02-tool-call-card`、`03-apply-workflow`、`04-inline-edit` |
| **P1 — 体系对齐** | 3 周 | `05-codebase-index`、`06-rules-memories`、`07-mcp-hooks`、`08-shell-allowlist` |
| **P2 — 体验提升** | 2 周 | `09-branch-tree`、`10-context-multimodal`、`11-model-router`、`12-slash-commands` |
| **P3 — 差异化**   | 4 周+ | `13-background-agents`、`14-share-export`、`15-tab-multiline` |

## 4. 总体设计原则

1. **后端结构化、前端纯渲染**:废弃 `activeReplyRef`/`activeTurnIdRef` 这类前端
   状态机,所有交互状态由后端的 `turn / step / event` 树驱动。
2. **事件携带 seq + turnId + stepId**:三元组定位,允许乱序、补传、断点续传。
3. **工具调用具备双向回传**:`tool_call → tool_progress* → tool_result`,result
   必须含 `payload`(结构化结果),不仅是 `ok`。
4. **写盘动作走"暂存 → 预览 → 接受 → 落盘"四段**,默认不直接落盘。
5. **所有面板组件遵循"无数据则不渲染"**,避免 Tab 列表与功能强耦合。

## 5. 路径与命名约定

```
plugin/webui/src/
├── App.tsx                    # 仅做路由 + 顶层 layout
├── state/
│   ├── turnReducer.ts         # 新增:turn/step 状态机
│   ├── sessionStore.ts        # zustand 或 useReducer
│   └── events.ts              # 新增:统一事件类型
├── components/
│   ├── chat/                  # ChatView 拆分
│   ├── inline/                # Cmd+K 内联组件
│   ├── apply/                 # Hunk Apply UI
│   ├── tools/                 # ToolCallCard 拆分
│   ├── codebase/              # Index 状态卡
│   ├── rules/                 # Rules 编辑器
│   ├── mcp/                   # MCP 面板
│   └── shell/                 # 命令确认 / 流式终端
└── bridge.ts                  # 扩展事件类型枚举

plugin/src/main/kotlin/io/codepilot/plugin/
├── protocol/                  # 新增:Event/Turn/Step 数据类
├── inline/                    # Cmd+K 后端
├── apply/                     # Patch 暂存/接受
├── rules/                     # Rules 加载器升级
├── hooks/                     # 新增:Hook 引擎
└── shell/                     # Allowlist + 流式
```

## 6. 子文档索引

- [01 事件协议 / 状态机重构](./01-event-protocol.md)
- [02 工具调用卡片](./02-tool-call-card.md)
- [03 Hunk 级 Apply 工作流](./03-apply-workflow.md) ✅
- [04 Cmd+K 内联编辑 + Tab 反馈](./04-inline-edit.md) ✅
- **[P0 阶段总结(含服务端核查 / 下一步建议)](./P0-summary.md)** ⭐
- **[后端 & Prompt 模板审计(对照 Cursor 标准)](./backend-audit.md)** ⭐
- [05 Codebase 索引与语义检索](./05-codebase-index.md) ✅
- [06 Rules + Memories](./06-rules-memories.md) ✅
- [07 MCP / Hooks 管理](./07-mcp-hooks.md) ✅
- [08 Shell Allowlist 与流式输出](./08-shell-allowlist.md) ✅
- **[P1 阶段总结(含后端/prompt 核查)](./P1-summary.md)** ⭐
- [09 会话分支树 UI 与历史增强](./09-branch-tree.md) ✅
- [10 Context Budget Breakdown 与多模态输入](./10-context-multimodal.md) ✅
- [11 模型 Auto 路由、Max 模式与 Usage 仪表盘](./11-model-router.md) ✅
- [12 Slash Commands、Prompt 模板、通知与 @ 修复](./12-slash-commands.md) ✅
- **[P2 阶段总结(含后端/prompt 核查)](./P2-summary.md)** ⭐
- [13 Background Agents:并行任务、隔离 worktree](./13-background-agents.md) ✅
- [14 会话分享与导出](./14-share-export.md) ✅
- [15 Tab 多行预测与跨光标跳跃](./15-tab-multiline.md) ✅
- **[P3 阶段总结(含限制与后续增强)](./P3-summary.md)** ⭐
- [16 对标 Cursor 路线图](./16-对标Cursor路线图.md)

## 7. 验收基线

所有 P0/P1 项需通过以下验收:

1. 端到端事件可在 `ConsolePanel` 中以原始 JSON 形式回放,seq 单调递增。
2. 关闭网络 10s 后重连,前端能基于本地缓冲的最后 seq 调用 `replay_since(seq)`
   补齐,turn 树状态一致。
3. 任何写盘动作可被 `Undo all AI changes` 完整回滚到本次 turn 起点。
4. Inline Edit 接受后,文件实际内容与预览 diff 完全一致(行号、换行符、BOM)。
5. MCP server 启停、Hook 触发、Allowlist 命中均在 ConsolePanel 留痕。
