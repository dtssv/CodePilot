# Web UI（浏览器客户端）

> `apps/web/`：React + Vite + Tailwind 的单页应用，通过 WebSocket 说
> [headless 协议](./PROTOCOL.md)。它是**纯客户端**——不含 agent 逻辑，
> 所有能力来自 `codepilot serve --web` 那一端。
>
> 对应 ROADMAP-NEXT §4.3 Phase 2–4。

## 跑起来

```bash
# 1. 在项目目录起协议服务端（打印带 token 的 URL）
codepilot serve --web
# → ws://127.0.0.1:4179/rpc?token=...

# 2. 另一个终端起前端（dev 模式在 5173，属于不同 origin，要显式放行）
codepilot serve --web --allow-origin http://localhost:5173
corepack pnpm --filter @codepilot/web dev
```

打开 `http://localhost:5173`，把服务端打印的整行 URL 粘进顶部 **server** 输入框
（token 会被自动拆出来，不用单独填），填 **cwd**，点 Connect。

生产构建是纯静态文件：`corepack pnpm --filter @codepilot/web build` → `dist/`。
也可以由协议服务端自己托管：`codepilot serve --web --web-root ./apps/web/dist`，同一端口提供 SPA 与 WebSocket。

## 界面

| 区域 | 内容 |
|---|---|
| 顶栏 | server / token / cwd + 连接状态。token 用 password 输入框，避免截屏泄露 |
| 左栏 | 会话列表（New / Refresh / Fork），点一条就 `session/resume` |
| 主区 | 转录：用户消息、流式 assistant 文本、工具卡片、diff、plan、team 日志、压缩/错误提示 |
| 输入框 | ⏎ 发送、⇧⏎ 换行 |
| 底栏 | 状态、模式切换（chat/plan/agent）、模型、token 用量与花费、cancel |
| 弹窗 | 权限确认、`ask_user_question` / `plan_done` 提问 |

**工具卡片**默认折叠成一行（状态点 + 工具名 + 关键参数），点开看完整
input/result；输出被 spill 成 artifact 时显示引用。

**diff 展示**：协议里并没有 diff——工具调用带的是 agent 选择的**输入**。所以视图
是从输入推出来的：`write_file` 整份内容按新增渲染，`edit_file` 把每个
search/replace 对渲染成「先删后加」，多 edit 模式逐个标 `edit i of n`，
`global_replace` / `regex` 会额外标一行（它们改变了这个 diff 的含义）。
**这不是 diff 算法**，而是「agent 请求的改动」本身，也正是审批前该看的东西。
单个 hunk 超过 400 行会截断，不然一个 5000 行的文件能把标签页卡死。

**权限弹窗**里命令/路径**不截断也不折行隐藏**：看不全就点同意，正是这个弹窗要
防的事。

## 架构

```
App.tsx ──useReducer──> state/reducer.ts   （纯函数：事件 → rows）
   │                         ↑
   │                    state/diff.ts       （工具输入 → 改动视图模型）
   │
   └──> protocol/client.ts ──> Peer（@codepilot/protocol/rpc）
                                 └──> protocol/transport.ts（原生 WebSocket）
```

- **状态层是纯的**：`reducer.ts` 不认识 React 也不认识 client，所以增量累积、
  工具配对、状态机、用量累加这些真正容易错的地方都能在 node 里直接测
  （`test/reducer.test.ts`）。组件是薄壳。
- **恢复会话与实时事件走同一条路**：`session-opened` 带 history 时，历史事件是
  被同一个 reducer 重放的，不存在第二套渲染逻辑。
- **复用 `Peer`**：JSON-RPC 的 id 关联、反向请求、错误映射不重写一遍。
  从 `@codepilot/protocol/rpc` 子路径导入——主入口会连带 `@codepilot/core`
  （fs / child_process）一起进 bundle。
- **对 core 只做 `import type`**：类型在编译期就被擦掉，运行时一行 core 代码都
  不会进 bundle（`verbatimModuleSyntax: true` 保证了这点，构建产物已验证不含
  `child_process` / `node:fs` / core 符号）。

## 几个不显眼但重要的点

**用户消息不做乐观渲染**。`agent.ts` 会把用户消息写进转录，服务端照常作为
`event` 推回来——UI 再自己加一条就会每句话显示两遍。

**掉线不清空转录**。socket 断了只是标记 disconnected，用户正在读的内容留在屏幕
上；重连后 `session/resume` 会重新灌一遍。

**running 状态不会顶掉已弹出的对话框**。agent 等你回答时状态事件还在继续来，
如果照单全收会把权限弹窗关掉。

**token 存在 `localStorage` 并带 24 小时 TTL**。它等价于在这台机器上执行
命令的权限，所以加了过期：24 小时后自动失效，用户需重新输入——在"刷新页面不丢
token"的便利和"凭证不该永久存活"之间取平衡。server URL 和 cwd 无害，同样放
`localStorage`。页面还带了 CSP：`connect-src` 只允许本机 ws，`default-src 'self'`，
不加载任何远端资源——一个被投毒的依赖没法把转录或 token 发出去。
（早期版本用 `sessionStorage`，刷新即丢，体验太差；24h TTL 是折中后的选择。）

**浏览器不告诉你握手为什么失败**（状态码都拿不到），所以连接失败的提示只能把三种
常见原因列出来：服务端没起、token 不对、origin 不在白名单。

## 当前状态与后续增强

已完成：文件浏览器、只读/受控编辑器、workspace 搜索/写入/stat/watch、Git 状态与 diff、bash 输出面板、静态 SPA 托管、自动重连与会话恢复、真实浏览器 E2E 验收。

### Git diff 预览

点击 Git 变更列表只加载 patch，不再隐式打开编辑器，因此删除文件也可查看 diff，且不会覆盖当前编辑缓冲区。`Toggle staged` 会对当前文件重新请求 staged/unstaged patch；加载时清空旧 patch，显示加载状态、错误和服务端截断提示。快速切换时只采用最新请求的响应，关闭面板或切换连接后丢弃迟到响应。未跟踪文件没有 Git diff patch，面板会明确提示。

回归验证：`apps/web/test/gitDiff.test.ts` 覆盖请求参数、模式切换、竞态、关闭、错误和失效处理；`workspaceEditor.test.ts` 覆盖保存基线与冲突；`test/reconnect.test.ts` 使用真实 WebSocket 服务验证断线重连。`test/e2e/web.e2e.test.ts` 使用系统 Chrome CDP 验证真实 SPA、连接、session、文件编辑保存、外部修改、watch 刷新和服务重启恢复。Web 全套 63 个单元/协议客户端测试通过，另有 2 个真实浏览器 E2E 通过。

### 编辑器保存生命周期

保存成功后同步更新内容、大小和两份 hash 基线，防止将自己的保存误判为外部修改。截断内容只读且禁止保存；保存期间编辑器只读。外部删除也视为冲突，轮询不重叠且丢弃失效响应。`Reload` 可重新读取文件（存在未保存修改时先确认）；切换文件、刷新目录和关闭页面也有未保存提醒。快速连续打开文件只采用最新读取结果。

`apps/web/test/workspaceEditor.test.ts` 覆盖保存基线、二次编辑、删除/内容冲突与保存条件（4 项）。这些是状态逻辑测试，不替代真实浏览器交互测试。

后续增强：

- Monaco 完整编辑器（语法高亮、折叠、多光标）
- xterm.js 交互式终端
- 图片附件入口
- 多会话并排、断线自动重连
- 文件系统事件推送已使用 `workspace/watch` + `workspace/changed`；`workspace/stat` hash 轮询保留为 watcher 故障时的兜底
- Git diff staged/unstaged 的更丰富视图

## 相关文档

- [`docs/PROTOCOL.md`](./PROTOCOL.md) — 协议与 WebSocket 传输、安全模型
- [`docs/TEAMS.md`](./TEAMS.md) — `team_message` 的来源
- [`docs/SESSION.md`](./SESSION.md) — 会话、事件与持久化
