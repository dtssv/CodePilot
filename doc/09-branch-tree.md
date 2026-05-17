# 09 — 会话分支树 UI 与历史增强(P2)

## 1. 目标

替换 `App.tsx:838-854` 的 `<select>` 分支切换,用 **可视化分支树** 表达
fork 关系;同时增强 SessionSidebar(搜索、分组、固定、归档、悬停摘要)。

## 2. 现状

- `BranchTimeline.tsx` 组件已存在但**没有在 App 中挂载**。
- `SessionSidebar` 只是一个 popup,没有搜索/分组/pin。
- `branches` 用 `<select>`,无法表达 `parentBranchId` 形成的树。

## 3. 数据扩展

```ts
// state/events.ts
export interface BranchNode {
  branchId: string;
  sessionId: string;             // 等于 branchId(每个分支独立 session)
  parentBranchId: string | null;
  forkMsgIndex: number | null;
  title: string;                 // "main" / 自动生成 "fork @ msg #12"
  createdAt: number;
  messageCount: number;
  active: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  pinned: boolean;
  archived: boolean;
  preview: string;          // 首条用户消息前 80 字符
  branches: BranchNode[];
}
```

Kotlin `SessionStore.kt` 在 emit `session_list` 时附加 `pinned/archived/preview/
branches` 字段;现有 `branch_list` 事件可保留(向后兼容)。

## 4. 后端端点扩展

```
session.pin       { id, pinned: bool }
session.archive   { id, archived: bool }
session.rename    { id, title }
session.search    { query, includeArchived }  → 异步返回 session.search.result
session.duplicate { id }                       (创建一个完整复制,可作 sandbox)
branch.tree       { sessionId }                → branch.tree.result
```

## 5. 前端 — 分支树

`plugin/webui/src/components/branches/BranchTreeView.tsx`:

```tsx
import { useChatStore } from '../../state/sessionStore';
import { sendToPlugin } from '../../bridge';

interface TreeNode { branch: BranchNode; children: TreeNode[]; depth: number; }

function buildTree(branches: BranchNode[]): TreeNode[] {
  const byParent = new Map<string | null, BranchNode[]>();
  branches.forEach(b => {
    const arr = byParent.get(b.parentBranchId) ?? [];
    arr.push(b);
    byParent.set(b.parentBranchId, arr);
  });
  const walk = (parent: string | null, depth: number): TreeNode[] =>
    (byParent.get(parent) ?? []).sort((a, b) => a.createdAt - b.createdAt)
      .map(b => ({ branch: b, depth, children: walk(b.branchId, depth + 1) }));
  return walk(null, 0);
}

export function BranchTreeView({ sessionId }: { sessionId: string }) {
  const branches = useChatStore(s => s.branches.filter(b => b.sessionId.startsWith(sessionId) || true));
  const tree = buildTree(branches);
  if (branches.length <= 1) return null;

  const render = (n: TreeNode): React.ReactNode => (
    <div key={n.branch.branchId} className="branch-node" style={{ marginLeft: n.depth * 16 }}>
      <div className={`branch-row ${n.branch.active ? 'active' : ''}`}>
        <span className="branch-glyph">{'│  '.repeat(Math.max(0, n.depth - 1))}{n.depth > 0 ? '└─ ' : ''}</span>
        <button className="branch-title"
          onClick={() => sendToPlugin('switch_branch', { sessionId: n.branch.sessionId })}>
          {n.branch.title}
        </button>
        {n.branch.forkMsgIndex != null && (
          <span className="branch-fork">fork @ #{n.branch.forkMsgIndex}</span>
        )}
        <span className="branch-meta">{n.branch.messageCount} msgs</span>
        {!n.branch.active && (
          <button className="branch-delete"
            onClick={() => confirm('删除分支?') && sendToPlugin('delete_session', { sessionId: n.branch.sessionId })}>
            ✗
          </button>
        )}
      </div>
      {n.children.map(render)}
    </div>
  );

  return <div className="branch-tree">{tree.map(render)}</div>;
}
```

`App.tsx` 中替换 `branches.length > 1` 的 `<select>` 块:

```tsx
<BranchTreeView sessionId={activeSessionId} />
```

并在消息上下文菜单(已通过 `onForkFromMessage` 提供)加 "从此消息分支" 入口,
触发 `sendToPlugin('fork_from_message', { messageIndex })`,后端创建子 session
后 emit 新的 `branch_list`。

## 6. 前端 — 历史侧栏增强

`plugin/webui/src/components/sessions/SessionSidebarV2.tsx`:

```tsx
export function SessionSidebarV2() {
  const sessions = useChatStore(s => s.sessions);
  const activeId = useChatStore(s => s.activeSessionId);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const filtered = sessions.filter(s =>
    (!s.archived || showArchived) &&
    (query === '' || s.title.toLowerCase().includes(query.toLowerCase())
      || s.preview.toLowerCase().includes(query.toLowerCase())));

  const groups = groupByDate(filtered);

  return (
    <div className="session-sidebar-v2">
      <div className="search-row">
        <input placeholder="搜索会话..." value={query} onChange={e => setQuery(e.target.value)} />
        <label><input type="checkbox" checked={showArchived}
          onChange={e => setShowArchived(e.target.checked)} /> 归档</label>
      </div>

      {/* Pinned */}
      {filtered.filter(s => s.pinned).length > 0 && (
        <>
          <div className="group-title">📌 已固定</div>
          {filtered.filter(s => s.pinned).map(s => <SessionRow key={s.id} session={s} active={s.id === activeId} />)}
        </>
      )}

      {Object.entries(groups).map(([label, list]) => (
        <Fragment key={label}>
          <div className="group-title">{label}</div>
          {list.map(s => <SessionRow key={s.id} session={s} active={s.id === activeId} />)}
        </Fragment>
      ))}
    </div>
  );
}

function groupByDate(list: SessionMeta[]): Record<string, SessionMeta[]> {
  const now = Date.now();
  const day = 86400_000;
  const groups: Record<string, SessionMeta[]> = { '今天': [], '昨天': [], '本周': [], '更早': [] };
  list.forEach(s => {
    const d = now - s.updatedAt;
    if (d < day) groups['今天'].push(s);
    else if (d < day * 2) groups['昨天'].push(s);
    else if (d < day * 7) groups['本周'].push(s);
    else groups['更早'].push(s);
  });
  Object.keys(groups).forEach(k => groups[k].sort((a, b) => b.updatedAt - a.updatedAt));
  return Object.fromEntries(Object.entries(groups).filter(([_, v]) => v.length > 0));
}

function SessionRow({ session, active }: { session: SessionMeta; active: boolean }) {
  return (
    <div className={`session-row ${active ? 'active' : ''}`}
      onClick={() => sendToPlugin('switch_session', { sessionId: session.id })}
      title={session.preview}>
      <div className="session-title">{session.title}</div>
      <div className="session-preview">{session.preview}</div>
      <div className="session-meta">{session.messageCount} · {fmtRelative(session.updatedAt)}</div>
      <div className="session-actions">
        <button onClick={e => { e.stopPropagation();
          sendToPlugin('session.pin', { id: session.id, pinned: !session.pinned }); }}>
          {session.pinned ? '取消固定' : '固定'}
        </button>
        <button onClick={e => { e.stopPropagation();
          sendToPlugin('session.archive', { id: session.id, archived: !session.archived }); }}>
          {session.archived ? '取消归档' : '归档'}
        </button>
        <button onClick={e => { e.stopPropagation();
          const v = prompt('重命名', session.title);
          if (v) sendToPlugin('session.rename', { id: session.id, title: v }); }}>
          重命名
        </button>
        <button onClick={e => { e.stopPropagation();
          if (confirm('删除会话?')) sendToPlugin('delete_session', { sessionId: session.id }); }}>
          删除
        </button>
      </div>
    </div>
  );
}
```

## 7. 验收

1. fork 3 层分支 → BranchTreeView 显示完整树,缩进/连线正确,点击切换正确。
2. 在 100 个会话中搜索某关键字,响应 < 100ms(全部在前端 filter,后端无需介入)。
3. Pin 会话刷新 IDE 后仍 pin;Archive 会话默认不显示,toggle 后显示。
4. 任意会话上"重命名"立刻生效,Sidebar 与顶栏标题同步。
