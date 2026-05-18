# CodePilot 能力成熟度矩阵

> **Designed** | **Implemented** | **Integrated** | **Productized**  
> 详见 [gap-analysis-report.md](./gap-analysis-report.md)

| 文档 | Designed | Implemented | Integrated | Productized |
|------|----------|-------------|------------|-------------|
| [01-event-protocol](01-event-protocol.md) | ✅ | ✅ | ✅ 默认 v2 | ✅ hydrate + turn.metrics |
| [02-tool-call-card](02-tool-call-card.md) | ✅ | ✅ | ✅ v2 | ✅ |
| [03-apply-workflow](03-apply-workflow.md) | ✅ | ✅ | ✅ ChangePanel | ✅ staging 默认 true |
| [04-inline-edit](04-inline-edit.md) | ✅ | ✅ | ✅ IDE | ✅ |
| [05-codebase-index](05-codebase-index.md) | ✅ | ✅ | Tab + @ + add_ref | ✅ 对话 ref 芯片 |
| [06-rules-memories](06-rules-memories.md) | ✅ | ✅ | 注入 + pill | ✅ 待审队列 |
| [07-mcp-hooks](07-mcp-hooks.md) | ✅ | ✅ | Graph mcp.call | ✅ 输入区 banner |
| [08-shell-allowlist](08-shell-allowlist.md) | ✅ | ✅ | shell.progress | ✅ ShellStepCard |
| [09-branch-tree](09-branch-tree.md) | ✅ | ✅ | v2 BranchTimeline + Fork | ✅ 切换分支 |
| [10-context-multimodal](10-context-multimodal.md) | ✅ | ✅ | 发送 + 持久化 | ✅ v1/v2 图片回放 |
| [11-model-router](11-model-router.md) | ✅ | ✅ | Max + reasoning + Claude extraBody (Spring AI 1.1 + Alibaba Graph 1.1) | ✅ MaxModeHint 传输类型 |
| [12-slash-commands](12-slash-commands.md) | ✅ | ✅ | ✅ | ✅ |
| [13-background-agents](13-background-agents.md) | ✅ | ✅ | Tab + 云 sync | ✅ 云角标 + · DB/file |
| [14-share-export](14-share-export.md) | ✅ | ✅ | Tab + 云 | ✅ ExportPanel · DB + status |
| [15-tab-multiline](15-tab-multiline.md) | ✅ | ✅ | IDE + API | ✅ 来源统计 |

**P0**：集成 ~90% · 感知 ~80%（2026-05-18 v6）

**会话恢复**（发版/SSE 硬断）：[conversation-recovery-design.md](./conversation-recovery-design.md) — P0–P2b（drain + DB 队列 + 自动 `attach` 续流）；需 Flyway V10。
