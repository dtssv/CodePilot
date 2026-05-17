# 12 — Slash Commands、Prompt 模板、通知与 @ 兼容性修复(P2)

## 1. 目标

- 输入框支持 `/` 触发 **slash commands**(`/clear`, `/cost`, `/model`,
  `/compress`, `/branch`, `/run`, `/help` 以及用户自定义)。
- **Prompt 模板**:用户可保存常用 prompt 为模板,`/use template-name` 注入。
- **桌面通知**:长任务完成 / 需要输入 / 失败 时发送系统通知。
- 修复 `InputBar.tsx:138-146` 的 `@` 触发对中文标点不 break 的 bug。

## 2. Slash Commands

### 2.1 命令注册表

`plugin/webui/src/components/slash/commands.ts`:

```ts
export interface SlashCommand {
  name: string;
  aliases?: string[];
  args?: { name: string; required: boolean; suggest?: () => Promise<string[]> }[];
  description: string;
  run: (args: string[], ctx: SlashCtx) => Promise<void> | void;
}

export interface SlashCtx {
  setInput: (text: string) => void;
  resetSession: () => void;
}

import { sendToPlugin } from '../../bridge';
import { useChatStore } from '../../state/sessionStore';

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'clear', description: '清空当前会话(创建新会话)',
    run: (_args, ctx) => { sendToPlugin('new_session', {}); ctx.resetSession(); },
  },
  {
    name: 'cost', description: '显示当前会话成本',
    run: () => {
      const c = useChatStore.getState().sessionCost;
      alert(`Session cost: $${c.estimatedCostUsd.toFixed(4)} (${c.messageCount} msgs)`);
    },
  },
  {
    name: 'model', aliases: ['m'],
    args: [{ name: 'id', required: true,
             suggest: async () => useChatStore.getState().models.map(m => m.id) }],
    description: '切换模型',
    run: (args) => sendToPlugin('models.select', { id: args[0] }),
  },
  {
    name: 'compress', description: '压缩历史以释放上下文',
    run: () => sendToPlugin('compress_context', {}),
  },
  {
    name: 'branch', description: '从最新消息创建分支',
    run: () => sendToPlugin('fork_from_message', { messageIndex: -1 }),
  },
  {
    name: 'run', args: [{ name: 'command', required: true }],
    description: '执行 shell 命令(走 policy)',
    run: (args) => sendToPlugin('shell.exec_one', { command: args.join(' ') }),
  },
  {
    name: 'help', description: '列出所有命令',
    run: () => {
      const list = [...BUILTIN_COMMANDS, ...useChatStore.getState().customCommands];
      alert(list.map(c => `/${c.name} — ${c.description}`).join('\n'));
    },
  },
];
```

### 2.2 自定义命令

`.codepilot/commands.json`:

```json
{
  "commands": [
    {
      "name": "test",
      "description": "运行测试",
      "prompt": "Please run all tests in {{workspace}} and summarize failures."
    },
    {
      "name": "review",
      "description": "代码评审最近改动",
      "prompt": "Review my recent changes (git diff HEAD~1) for bugs and style issues."
    }
  ]
}
```

后端 `SlashCommandService` 读取并 emit `slash.commands.loaded`:

```kotlin
@Service(Service.Level.PROJECT)
class SlashCommandService(private val project: Project) {
  data class Spec(val name: String, val description: String, val prompt: String)
  fun list(): List<Spec> = readJson()
  fun reload() = bus.emit("system", "slash", "slash.commands.loaded",
    mapOf("commands" to list()))
}
```

自定义命令的 `run` 行为:把 `prompt` 模板做变量替换后填进输入框:

```ts
// 前端处理
{
  name: spec.name, description: spec.description,
  run: (args, ctx) => {
    const resolved = spec.prompt
      .replace('{{workspace}}', useChatStore.getState().workspacePath)
      .replace('{{selection}}', getCurrentSelection())
      .replace('{{args}}', args.join(' '));
    ctx.setInput(resolved);
  },
}
```

### 2.3 触发 UI

`plugin/webui/src/components/slash/SlashPopup.tsx`:

```tsx
export function SlashPopup({ query, anchorRect, onSelect, onClose }: {
  query: string; anchorRect?: DOMRect;
  onSelect: (cmd: SlashCommand) => void; onClose: () => void;
}) {
  const all = useAllCommands();
  const filtered = all.filter(c =>
    c.name.startsWith(query) || c.aliases?.some(a => a.startsWith(query)));
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (filtered[idx]) onSelect(filtered[idx]);
      }
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [filtered, idx, onSelect, onClose]);

  if (!filtered.length) return null;
  const style: React.CSSProperties = anchorRect
    ? { position: 'fixed', left: anchorRect.left, top: anchorRect.top + 20 }
    : {};
  return (
    <div className="slash-popup" style={style}>
      {filtered.map((c, i) => (
        <div key={c.name} className={`slash-item ${i === idx ? 'active' : ''}`}
             onClick={() => onSelect(c)}>
          <span className="slash-name">/{c.name}</span>
          <span className="slash-desc">{c.description}</span>
        </div>
      ))}
    </div>
  );
}
```

`InputBar.handleEditorInput` 中添加 `/` 检测:

```ts
const text = node.textContent || '';
const cursorOffset = range.startOffset;
// 在行首或空白后的 / 触发
const lineStart = text.lastIndexOf('\n', cursorOffset - 1) + 1;
const lineFromStart = text.substring(lineStart, cursorOffset);
const slashMatch = /^\/([\w-]*)$/.exec(lineFromStart);
if (slashMatch) {
  setSlashQuery(slashMatch[1]);
  setSlashAnchor(range.getBoundingClientRect());
  setSlashVisible(true);
  setAtPopupVisible(false);
  return;
}
setSlashVisible(false);
// ...原有 @ 检测
```

## 3. Prompt 模板(超出 slash 的全功能)

`plugin/webui/src/components/templates/TemplatesPanel.tsx`:

```tsx
interface Template { id: string; title: string; body: string; variables: string[]; }

export function TemplatesPanel() {
  const tpls = useChatStore(s => s.templates);
  const [editing, setEditing] = useState<Template | null>(null);

  return (
    <div className="templates-panel">
      <div className="row"><h3>Prompt 模板</h3>
        <button onClick={() => setEditing({ id: '', title: '', body: '', variables: [] })}>新建</button>
      </div>
      <ul>
        {tpls.map(t => (
          <li key={t.id}>
            <strong>{t.title}</strong>
            <span className="muted">{t.body.slice(0, 60)}…</span>
            <button onClick={() => useTemplate(t)}>插入</button>
            <button onClick={() => setEditing(t)}>编辑</button>
            <button onClick={() => sendToPlugin('templates.delete', { id: t.id })}>删除</button>
          </li>
        ))}
      </ul>
      {editing && (
        <TemplateEditor
          template={editing}
          onSave={t => { sendToPlugin('templates.save', t); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function useTemplate(t: Template) {
  let body = t.body;
  for (const v of t.variables) {
    const val = prompt(`${v}?`, '') ?? '';
    body = body.replaceAll(`{{${v}}}`, val);
  }
  // 写入输入框(通过 inputRef ref)
  document.dispatchEvent(new CustomEvent('codepilot:input.set', { detail: body }));
}
```

`InputBar` 监听 `codepilot:input.set` 把内容写到 editor。

后端持久化到 `.codepilot/templates.json`,启动时 emit `templates.loaded`。

## 4. 桌面通知

### 4.1 触发场景

- `turn.end` 且耗时 > 30s
- `turn.end` 且 status 为 `failed`
- `needs_input` 出现
- 窗口失焦时才发送(避免噪音)

### 4.2 实现

`plugin/webui/src/notifications/desktop.ts`:

```ts
let lastPermAsk = 0;
async function ensurePermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  if (Date.now() - lastPermAsk < 60_000) return Notification.permission;
  lastPermAsk = Date.now();
  return await Notification.requestPermission();
}

export async function notify(title: string, body: string, onClick?: () => void) {
  if (document.hasFocus()) return;
  const p = await ensurePermission();
  if (p !== 'granted') return;
  const n = new Notification(title, { body, icon: '/codepilot-icon.png' });
  if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
}
```

JCEF 默认不开启 Web Notifications,需要在 Kotlin 侧通过 IDE 通知中心兜底:

```kotlin
// CefBridge 注册 "ui.notify"
"ui.notify" -> {
  val title = payload.get("title").asString
  val body = payload.get("body").asString
  Notifications.Bus.notify(
    com.intellij.notification.Notification("CodePilot", title, body,
      com.intellij.notification.NotificationType.INFORMATION),
    project,
  )
}
```

前端在 Web Notification 不可用时降级到 `sendToPlugin('ui.notify', ...)`:

```ts
export async function notify(title: string, body: string, onClick?: () => void) {
  if (document.hasFocus()) return;
  try {
    const p = await ensurePermission();
    if (p === 'granted') {
      const n = new Notification(title, { body });
      if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
      return;
    }
  } catch {}
  sendToPlugin('ui.notify', { title, body }).catch(() => {});
}
```

### 4.3 接入 reducer

```ts
// turnReducer.ts
case 'turn.end': {
  const turn = state.turns.find(t => t.turnId === ev.turnId);
  if (turn) {
    const duration = ev.ts - turn.startedAt;
    if (duration > 30_000 || ev.payload.status === 'failed') {
      notify(
        ev.payload.status === 'failed' ? 'CodePilot 失败' : 'CodePilot 完成',
        turn.userMessage.slice(0, 100),
        () => { /* 切到对应会话 */ },
      );
    }
  }
  // ...
}
```

## 5. 长任务进度估计

当 turn 持续 > 10s 时,在 ChatView 顶部显示 ETA 条:

```tsx
function TurnProgressBar({ turn }: { turn: TurnNode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (turn.status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [turn.status]);
  if (turn.status !== 'running') return null;
  const elapsed = now - turn.startedAt;
  if (elapsed < 10_000) return null;
  // 用历史 turn 的中位数估计
  const eta = useChatStore.getState().medianTurnDuration ?? 60_000;
  const pct = Math.min(95, (elapsed / eta) * 100);
  return (
    <div className="turn-progress">
      <div className="turn-progress-bar" style={{ width: `${pct}%` }} />
      <span>{(elapsed / 1000).toFixed(1)}s · ETA ~{(eta / 1000).toFixed(0)}s</span>
    </div>
  );
}
```

`medianTurnDuration` 由 reducer 累积:

```ts
case 'turn.end': {
  const turn = state.turns.find(t => t.turnId === ev.turnId);
  if (turn && turn.startedAt) {
    state.turnDurations = [...(state.turnDurations || []).slice(-49), ev.ts - turn.startedAt];
    state.medianTurnDuration = median(state.turnDurations);
  }
  // ...
}
```

## 6. @ 触发中文标点修复

`InputBar.tsx:138-146` 用 `/\s/` 判断分隔符,中文标点(`,。;:、`)不命中。
修复:

```ts
const SEPARATORS = /[\s,，。;;:、!?!?\(\)\[\]\{\}「」『』""'']/;

let atIndex = -1;
for (let i = cursorOffset - 1; i >= 0; i--) {
  const ch = text[i];
  if (ch === '@') { atIndex = i; break; }
  if (SEPARATORS.test(ch)) break;
}
```

同时把 `handleAtSelect` 里相同的反向扫描(`InputBar.tsx:176-178`)统一替换为
共享常量 `SEPARATORS`。

## 7. 验收

1. 输入 `/cl` → SlashPopup 弹 `clear / `;Enter 即清空会话。
2. 输入 `/model gpt` → 第二个参数提示候选模型 id;选中后 `models.select` 被调用。
3. 自定义命令 `/test` → prompt 模板被替换后填入输入框,光标可继续编辑后发送。
4. 后台 IDE 触发长任务 30s+,窗口失焦 → 系统通知出现,点击聚焦回 IDE。
5. 输入"参考 @docs。" → `@docs` chip 正确创建,中文句号被识别为分隔符。
6. 长 turn 持续 > 10s 时进度条出现,ETA 基于历史中位数自动调整。
