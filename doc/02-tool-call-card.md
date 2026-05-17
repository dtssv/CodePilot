# 02 — 工具调用结构化卡片(P0)

> **实现状态:✅ 已完成(灰度上线)**
>
> 落地文件:
> - `plugin/src/main/kotlin/io/codepilot/plugin/protocol/ToolResultClassifier.kt`
>   覆盖 `fs.read / fs.list / fs.write / fs.grep / fs.search / shell.exec /
>   shell.session / ide.openFile / ide.diagnostics / ide.shadowValidate /
>   code.outline / mcp.* / notepad.*`,以及 error / unknown 兜底。
> - `plugin/webui/src/components/tools/v2/types.ts` — `ToolResultPayload`
>   discriminated union,与 Kotlin classifier 严格对齐。
> - `plugin/webui/src/components/tools/v2/{ToolCallCard,ToolArgsView,ToolResultView,ChatViewV2}.tsx`
> - `plugin/webui/src/components/tools/v2/toolResult.test.ts`(3 项端到端测试)
>
> 集成点:
> - `LegacyEventAdapter.onToolCall` 捕获 `JsonNode` 形式的 args;
>   `onToolResultAck` 调用 classifier 并发出 `tool.result` envelope。
> - `CefChatPanel.handleUserMessage` 的 `ToolDispatcher.onToolResult` 回调
>   从 `_` 改为 `result`,直接把原始结果交给 adapter。
> - 新增 Web → Plugin 端点 `tool.rerun`(`handleToolRerun`),在当前 turn 内
>   创建一个 rerun step,本地执行后只 emit envelope,不通过
>   `client.submitToolResult` 回灌 LLM。
>
> 灰度:已有的 legacy `tool_call` / `tool_result_ack` 事件完全保留,
> v2 envelope 是并行新通道。`localStorage.codepilot.protocol.v2 === '1'` 时,
> WebUI 可挂载 `<ChatViewV2 />` 替代 `<ChatView />`。
>
> 自检:`npx tsx src/components/tools/v2/toolResult.test.ts` — 3/3 通过。

## 1. 目标

把 `tool_call → tool_result_ack` 三态(running / success / error)升级为
**含 result payload、参数展开、错误详情、重跑、复制** 的结构化卡片。

## 2. 现状

- `App.tsx:294-352` 中 `tool_call` 只存 args + status,`tool_result_ack` 只更
  status,**完全丢弃 result 内容**。
- `pendingChanges` 解析用字符串前缀(`fs.write` / `fs.create` ...),新工具上线
  需改前端逻辑。
- 用户看不到:grep 返回了多少行、read 读了哪些区间、edit 的预览 diff。

## 3. 工具结果协议

依赖 `01-event-protocol.md` 的 `tool.result`,result payload 按工具类型分类:

```ts
// plugin/webui/src/components/tools/types.ts
export type ToolResultPayload =
  | { kind: 'fs.read'; path: string; range?: [number, number]; content: string; truncated: boolean }
  | { kind: 'fs.write'; path: string; op: 'create'|'replace'|'delete'; diff: UnifiedDiff; pendingId: string }
  | { kind: 'fs.applyPatch'; patches: { path: string; op: string; pendingId: string; diff: UnifiedDiff }[] }
  | { kind: 'grep'; matches: { path: string; line: number; preview: string }[]; total: number; truncated: boolean }
  | { kind: 'glob'; files: string[]; total: number; truncated: boolean }
  | { kind: 'shell'; cwd: string; command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { kind: 'web.fetch'; url: string; status: number; contentType: string; preview: string }
  | { kind: 'codebase.search'; query: string; hits: { path: string; score: number; snippet: string }[] }
  | { kind: 'unknown'; raw: unknown };

export interface UnifiedDiff {
  oldPath: string;
  newPath: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
}
```

后端 `ToolDispatcher` 的 `ToolResult` 必须返回上述 `kind` 标识的结构:

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/tools/ToolDispatcher.kt
sealed class ToolResult(val ok: Boolean) {
  data class FsRead(val path: String, val range: IntRange?, val content: String,
                    val truncated: Boolean) : ToolResult(true) {
    val kind = "fs.read"
  }
  data class FsWrite(val path: String, val op: String, val diff: UnifiedDiff,
                     val pendingId: String) : ToolResult(true) {
    val kind = "fs.write"
  }
  data class Shell(val cwd: String, val command: String, val exitCode: Int,
                   val stdout: String, val stderr: String, val durationMs: Long) : ToolResult(exitCode == 0) {
    val kind = "shell"
  }
  data class Grep(val matches: List<Match>, val total: Int, val truncated: Boolean) : ToolResult(true) {
    data class Match(val path: String, val line: Int, val preview: String)
    val kind = "grep"
  }
  data class Err(val message: String, val stack: String? = null) : ToolResult(false) {
    val kind = "error"
  }
  // ...
}
```

## 4. 前端组件树

```
ToolCallCard                    // 总卡片
├── ToolCallHeader              // 工具名 / 状态 / 折叠按钮 / duration
├── ToolArgsView                // 参数(默认折叠,展开后语法高亮)
└── ToolResultView              // 根据 result.kind 分派
    ├── FsReadResult            // 文件路径+行号区间+预览,带"在编辑器打开"
    ├── FsWriteResult           // mini-diff + Accept/Reject(详见 03 文档)
    ├── GrepResult              // 命中列表(可点击跳转)
    ├── ShellResult             // 终端样式输出 + 退出码
    ├── WebFetchResult          // URL + content-type + 预览
    ├── CodebaseSearchResult    // 命中列表 + 评分
    └── UnknownResult           // JSON 折叠展示
```

### 4.1 主组件

`plugin/webui/src/components/tools/ToolCallCard.tsx`:

```tsx
import { useState } from 'react';
import type { StepNode } from '../../state/events';
import { sendToPlugin } from '../../bridge';
import { ToolArgsView } from './ToolArgsView';
import { ToolResultView } from './ToolResultView';

export function ToolCallCard({ step }: { step: StepNode }) {
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(true);
  const call = step.toolCall;
  const result = step.toolResult;
  if (!call) return null;

  const duration = step.endedAt ? `${step.endedAt - step.startedAt}ms` : '...';
  const statusIcon = step.status === 'running' ? '⏳'
                   : step.status === 'success' ? '✓'
                   : step.status === 'error' ? '✗' : '·';

  return (
    <div className={`tool-card tool-status-${step.status}`}>
      <div className="tool-card-header">
        <span className="tool-icon">{statusIcon}</span>
        <span className="tool-name">{call.tool}</span>
        <span className="tool-summary">{summarize(call)}</span>
        <span className="tool-duration">{duration}</span>
        <button className="tool-action" onClick={() => navigator.clipboard.writeText(JSON.stringify(call.args, null, 2))}>
          复制参数
        </button>
        {step.status !== 'running' && (
          <button className="tool-action" onClick={() => sendToPlugin('tool.rerun', {
            stepId: step.stepId, tool: call.tool, args: call.args,
          })}>
            重跑
          </button>
        )}
      </div>

      <div className="tool-card-section">
        <button className="tool-section-toggle" onClick={() => setArgsOpen(v => !v)}>
          {argsOpen ? '▼' : '▶'} Arguments
        </button>
        {argsOpen && <ToolArgsView args={call.args} />}
      </div>

      {(result || step.status === 'running') && (
        <div className="tool-card-section">
          <button className="tool-section-toggle" onClick={() => setResultOpen(v => !v)}>
            {resultOpen ? '▼' : '▶'} Result
          </button>
          {resultOpen && (
            result
              ? <ToolResultView result={result} />
              : <ToolProgressView detail={step.progressDetail} />
          )}
        </div>
      )}
    </div>
  );
}

/** 一行 summary,避免用户必须展开才能看出工具做了什么 */
function summarize(call: { tool: string; args: any }): string {
  const a = call.args || {};
  switch (true) {
    case call.tool.startsWith('fs.read'):
      return `${a.path}${a.startLine ? `:${a.startLine}-${a.endLine ?? ''}` : ''}`;
    case call.tool.startsWith('fs.write'):
      return `${a.op ?? 'edit'} ${a.path ?? '(multiple)'}`;
    case call.tool === 'grep':
      return `"${a.pattern}" in ${a.path ?? 'workspace'}`;
    case call.tool === 'shell':
      return a.command ?? '';
    case call.tool === 'web.fetch':
      return a.url ?? '';
    default:
      return Object.keys(a).slice(0, 3).map(k => `${k}=${JSON.stringify(a[k]).slice(0, 30)}`).join(' ');
  }
}
```

### 4.2 Result 分派

`plugin/webui/src/components/tools/ToolResultView.tsx`:

```tsx
import type { StepNode } from '../../state/events';
import { FsReadResult } from './FsReadResult';
import { FsWriteResult } from './FsWriteResult';
import { GrepResult } from './GrepResult';
import { ShellResult } from './ShellResult';
import { WebFetchResult } from './WebFetchResult';
import { CodebaseSearchResult } from './CodebaseSearchResult';

export function ToolResultView({ result }: { result: NonNullable<StepNode['toolResult']> }) {
  if (!result.ok) {
    return (
      <div className="tool-result-error">
        <div className="error-title">Error</div>
        <pre className="error-message">{result.error || 'Unknown error'}</pre>
      </div>
    );
  }
  const payload = result.result as any;
  switch (payload?.kind) {
    case 'fs.read':           return <FsReadResult data={payload} />;
    case 'fs.write':          return <FsWriteResult data={payload} />;
    case 'fs.applyPatch':     return <>{payload.patches.map((p: any, i: number) =>
                                <FsWriteResult key={i} data={{ kind: 'fs.write', ...p }} />)}</>;
    case 'grep':              return <GrepResult data={payload} />;
    case 'shell':             return <ShellResult data={payload} />;
    case 'web.fetch':         return <WebFetchResult data={payload} />;
    case 'codebase.search':   return <CodebaseSearchResult data={payload} />;
    default:
      return <pre className="tool-result-raw">{JSON.stringify(payload, null, 2)}</pre>;
  }
}
```

### 4.3 GrepResult 示例(可点击跳转)

```tsx
import { sendToPlugin } from '../../bridge';

export function GrepResult({ data }: { data: any }) {
  return (
    <div className="grep-result">
      <div className="grep-summary">
        {data.total} matches{data.truncated ? ' (truncated)' : ''}
      </div>
      <ul className="grep-hits">
        {data.matches.map((m: any, i: number) => (
          <li key={i}>
            <button
              className="grep-hit-link"
              onClick={() => sendToPlugin('open_file', { path: m.path, line: m.line })}
            >
              {m.path}:{m.line}
            </button>
            <code className="grep-hit-preview">{m.preview}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### 4.4 ShellResult(终端样式)

```tsx
export function ShellResult({ data }: { data: any }) {
  return (
    <div className="shell-result">
      <div className="shell-header">
        <span className="shell-cwd">{data.cwd}</span>
        <span className={`shell-exit ${data.exitCode === 0 ? 'ok' : 'err'}`}>
          exit {data.exitCode} · {data.durationMs}ms
        </span>
      </div>
      <pre className="shell-cmd">$ {data.command}</pre>
      {data.stdout && <pre className="shell-stdout">{data.stdout}</pre>}
      {data.stderr && <pre className="shell-stderr">{data.stderr}</pre>}
    </div>
  );
}
```

## 5. 移除前端硬编码

`App.tsx:306-320` 的写工具识别(`fs.write` / `fs.create` / `fs.replace` / 
`fs.applyPatch` / `fs.delete` 字符串判断)整体删除,改由后端在
`tool.result` 携带 `kind: 'fs.write' | 'fs.applyPatch'` 且自带 `pendingId`,
前端只消费 `pendingId`(详见 `03-apply-workflow.md`)。

## 6. 重跑端点

后端 `CefBridge` 注册:

```kotlin
"tool.rerun" -> {
  val stepId = payload.get("stepId").asString
  val tool = payload.get("tool").asString
  val args = payload.get("args")
  // 在 *新的* stepId 下执行,避免污染原 step
  val newStepId = "${stepId}-rerun-${System.nanoTime()}"
  val turnId = SessionState.activeTurnId() ?: return
  bus.emit(turnId, newStepId, "step.start",
    mapOf("stepId" to newStepId, "kind" to "tool", "title" to "$tool (rerun)"))
  bus.emit(turnId, newStepId, "tool.call",
    mapOf("stepId" to newStepId, "tool" to tool, "args" to args))
  val r = ToolDispatcher.invoke(tool, args)
  bus.emit(turnId, newStepId, "tool.result",
    mapOf("stepId" to newStepId, "ok" to r.ok, "result" to r, "error" to (r as? Err)?.message))
}
```

## 7. 测试

- snapshot:每种 `kind` 的 result 渲染快照。
- 交互:点击 Grep hit → 验证 `open_file` 被调用且参数正确。
- 边界:result 缺失 `kind` → fallback 到 `UnknownResult`;`ok=false` 时显示
  `error` payload 不渲染成功内容。
