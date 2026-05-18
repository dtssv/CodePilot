# 05 — Codebase 索引与语义检索(P1) ✅ Completed

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> 已实现: `IndexScheduler.CodebaseStatus` + `emitStatus/statusSnapshot/pause/resume/setIgnorePatterns`;
> `CefChatPanel` 暴露 `codebase.get_status/rebuild/pause/resume/search/set_ignore`;
> WebUI `state/codebase.ts` + `components/codebase/CodebasePanel.tsx`。后端核查:
> `/v1/rag/index/search/delete` 已存在,但本功能采用本地 TF-IDF/PSI 索引,无需上传代码到后端。

## 1. 目标

让用户像 Cursor 一样:

- 看到 codebase 索引状态(已索引文件数 / 进度 / 失败 / 上次完成时间)
- 一键 **重建索引**、暂停、配置忽略
- `@Codebase` 真正能产出语义命中并在聊天里以"Searched codebase: N files"卡片呈现

## 2. 现状

- `plugin/src/main/kotlin/io/codepilot/plugin/indexer/IndexScheduler.kt`、
  `LocalSearchEngine.kt`、`AdaptiveDepthSearcher.kt` 已经实现了索引引擎,
  但 WebUI 没有任何索引状态面板,`@Codebase` 在 chip 创建后无可视反馈。

## 3. 协议扩展

### 3.1 envelope 事件

```ts
type EventType = | ...prev
  | 'codebase.status'   // payload: CodebaseStatus
  | 'codebase.search.result'; // payload: CodebaseSearchResult

interface CodebaseStatus {
  state: 'idle'|'scanning'|'indexing'|'paused'|'error';
  totalFiles: number; indexedFiles: number; failedFiles: number;
  lastIndexedAt?: number;
  embeddingModel: string;
  ignored: string[];           // 来自 .cursorindexignore + .gitignore
  error?: string;
}

interface CodebaseSearchResult {
  query: string;
  hits: { path: string; score: number; snippet: string; startLine: number; endLine: number }[];
  durationMs: number;
}
```

### 3.2 Web → Plugin 端点

```
codebase.rebuild           — 全量重建
codebase.pause / resume    — 暂停/恢复
codebase.search { query, topK }
codebase.set_ignore { patterns: string[] }
codebase.get_status
```

## 4. 后端

### 4.1 IndexScheduler 暴露状态

```kotlin
// IndexScheduler.kt 新增
@Service(Service.Level.PROJECT)
class IndexScheduler(private val project: Project) {
  private val bus get() = project.getService(EventBus::class.java)
  @Volatile private var state = CodebaseState()

  data class CodebaseState(
    val state: String = "idle",
    val totalFiles: Int = 0, val indexedFiles: Int = 0, val failedFiles: Int = 0,
    val lastIndexedAt: Long? = null,
    val embeddingModel: String = "text-embedding-3-small",
    val ignored: List<String> = listOf(),
    val error: String? = null,
  )

  fun rebuild() {
    state = state.copy(state = "scanning", indexedFiles = 0, failedFiles = 0)
    emitStatus()
    coroutineScope.launch {
      val files = scanWorkspace()
      state = state.copy(state = "indexing", totalFiles = files.size)
      emitStatus()
      files.forEachIndexed { i, f ->
        runCatching { indexer.indexFile(f) }
          .onSuccess { state = state.copy(indexedFiles = state.indexedFiles + 1) }
          .onFailure { state = state.copy(failedFiles = state.failedFiles + 1) }
        if (i % 50 == 0) emitStatus()   // 节流
      }
      state = state.copy(state = "idle", lastIndexedAt = System.currentTimeMillis())
      emitStatus()
    }
  }

  fun pause()  { state = state.copy(state = "paused"); emitStatus() }
  fun resume() { state = state.copy(state = "indexing"); emitStatus(); /* 继续队列 */ }

  fun emitStatus() = bus.emit("system", "codebase", "codebase.status", state)
}
```

### 4.2 语义检索作为工具

`codebase.search` 端点直接调用,不需要走 LLM。但 LLM 通过工具
`codebase_search` 调用时,同样产出 `tool.result` 并附带
`kind: 'codebase.search'`(已在 02 文档定义)。

```kotlin
// CefBridge 处理
"codebase.search" -> {
  val q = payload.get("query").asString
  val topK = payload.get("topK")?.asInt ?: 12
  val t0 = System.currentTimeMillis()
  val hits = LocalSearchEngine.getInstance(project).semanticSearch(q, topK)
  bus.emit("system", "codebase-search-${t0}", "codebase.search.result",
    mapOf("query" to q, "hits" to hits, "durationMs" to (System.currentTimeMillis() - t0)))
}
```

### 4.3 ignore 配置

新增 `.cursorindexignore` 等价文件(沿用名称 `.codepilotindexignore`),由
`AtReferenceProvider.kt` 同一套 glob 引擎加载;`set_ignore` 端点把新规则写回
工作区文件 + 触发 `rebuild`。

## 5. 前端

### 5.1 状态面板 CodebasePanel

`plugin/webui/src/components/codebase/CodebasePanel.tsx`:

```tsx
import { useChatStore } from '../../state/sessionStore';
import { sendToPlugin } from '../../bridge';

export function CodebasePanel() {
  const s = useChatStore(st => st.codebase);
  const pct = s.totalFiles ? Math.floor(s.indexedFiles * 100 / s.totalFiles) : 0;

  return (
    <div className="codebase-panel">
      <div className="codebase-header">
        <span>Codebase Index</span>
        <span className={`codebase-state state-${s.state}`}>{s.state}</span>
      </div>

      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <span className="progress-text">{s.indexedFiles} / {s.totalFiles} ({pct}%)</span>
      </div>
      {s.failedFiles > 0 && <div className="warn">失败 {s.failedFiles} 个文件</div>}
      {s.lastIndexedAt && <div className="muted">上次完成:{new Date(s.lastIndexedAt).toLocaleString()}</div>}
      {s.error && <div className="error">{s.error}</div>}

      <div className="codebase-actions">
        <button onClick={() => sendToPlugin('codebase.rebuild', {})}>重建</button>
        {s.state === 'indexing'
          ? <button onClick={() => sendToPlugin('codebase.pause', {})}>暂停</button>
          : s.state === 'paused'
          ? <button onClick={() => sendToPlugin('codebase.resume', {})}>恢复</button>
          : null}
      </div>

      <details className="codebase-ignore">
        <summary>忽略规则 ({s.ignored.length})</summary>
        <textarea
          defaultValue={s.ignored.join('\n')}
          rows={6}
          onBlur={e => sendToPlugin('codebase.set_ignore',
            { patterns: e.target.value.split('\n').map(x => x.trim()).filter(Boolean) })}
        />
      </details>
    </div>
  );
}
```

### 5.2 在 InputBar 顶部展示快速指示

```tsx
// InputBar.tsx 顶部加一行
const cb = useChatStore(s => s.codebase);
{cb.state !== 'idle' && (
  <div className="codebase-indicator">
    <span className="spinner" /> 索引中 {cb.indexedFiles}/{cb.totalFiles}
  </div>
)}
```

### 5.3 @Codebase 命中卡片

当 LLM 调用 `codebase_search` 时,02 文档定义的 `CodebaseSearchResult` 组件即可。
当用户在 `@Codebase` chip 上选了一项后,后端会主动 emit `codebase.search.result`,
WebUI 在输入区上方插入一张悬浮卡:"Searched codebase: 12 files for "..." ",
点击展开查看 hits,可勾选保留为上下文 chip。

`plugin/webui/src/components/codebase/CodebaseSearchCard.tsx`:

```tsx
export function CodebaseSearchCard({ result }: { result: CodebaseSearchResult }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="codebase-search-card">
      <div className="cs-header" onClick={() => setOpen(v => !v)}>
        <span>{open ? '▼' : '▶'}</span>
        Searched codebase: {result.hits.length} files for "{result.query}"
        <span className="muted">({result.durationMs}ms)</span>
      </div>
      {open && (
        <ul className="cs-hits">
          {result.hits.map((h, i) => (
            <li key={i}>
              <button onClick={() => sendToPlugin('open_file', { path: h.path, line: h.startLine })}>
                {h.path}:{h.startLine}-{h.endLine}
              </button>
              <span className="score">{h.score.toFixed(2)}</span>
              <pre className="snippet">{h.snippet}</pre>
              <button className="pin" onClick={() => sendToPlugin('context_added', {
                id: `cb-${h.path}-${h.startLine}`,
                type: 'code', display: `${h.path.split('/').pop()}:${h.startLine}`,
                filePath: h.path, language: '', startLine: h.startLine, endLine: h.endLine,
              })}>固定为上下文</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

## 6. 性能

- 索引进度 emit 节流到 ≥500ms/次,避免事件风暴
- `LocalSearchEngine.semanticSearch` 加 LRU 缓存(query → hits,TTL 30s)
- WebUI store 中 `codebase` 字段 shallow 比较(zustand `subscribeWithSelector`)

## 7. 验收

1. 打开一个 5000 文件的工程,点 "重建" → CodebasePanel 进度条平滑增长,无卡顿。
2. 输入 `@codebase` 选项 → 输入 "rate limiter" → 5 秒内返回 ≤12 命中,点击可跳转。
3. 在 `.codepilotindexignore` 中加 `build/` → 重建后,索引文件总数下降。
4. LLM 自主调用 `codebase_search` 工具时,ChatView 中出现命中卡片,与
   `@Codebase` 卡片样式一致。
