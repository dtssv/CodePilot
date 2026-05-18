# 15 — Tab 多行预测与跨光标跳跃(P3)

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> ✅ Completed(2026-05-17):基于已有 `CursorTabSuggester` 完成多行 ghost 渲染、
> 后续位置预测、Tab accept 写命令包裹、accept/dismiss telemetry。修复了
> inline completion 后续建议被立即 `acceptCurrent()` 的问题,现在只渲染预测。

## 1. 目标

把现有 `CodePilotInlineCompletionProvider`(单行 ghost text)升级为对齐 Cursor
Tab 的体验:

- **多行预测**:在当前光标处建议跨多行的整体改动。
- **跨位置跳跃**:接受当前建议后,光标自动跳到下一个建议位置(链式编辑)。
- **删除/移动预测**:不仅"插入",还能预测"删除 N 行"或"把这段挪到 X"。

> 注:这是一个大特性,且强依赖模型质量,本文档给出**架构与协议**层面的可落地
> 设计,具体模型 prompt/解码细节会随模型变化迭代。

## 2. 现状

- `CodePilotInlineCompletionProvider.kt` 实现了 IntelliJ 的
  `InlineCompletionProvider`,只能产出单段 ghost text。
- 没有"接受后跳转下一个位置"的能力(IntelliJ 原生 ghost text 不支持)。

## 3. 协议

### 3.1 Suggestion 数据

```kotlin
data class TabSuggestion(
  val id: String,                       // 服务端生成,接受时回报
  val edits: List<Edit>,                // 一次建议可包含多个 edit
  val cursorAfter: CursorPosition?,     // 接受后光标应跳转到的位置(可在其它文件)
  val nextSuggestionHint: NextHint?,    // 提示存在后续可链式接受的建议
  val confidence: Double,               // [0,1]
)

data class Edit(
  val file: String,                     // workspace 相对路径
  val range: TextRange,                 // 替换范围(0 长度即纯插入)
  val newText: String,
  val kind: EditKind,                   // INSERT | REPLACE | DELETE | MOVE
)
enum class EditKind { INSERT, REPLACE, DELETE, MOVE }

data class CursorPosition(val file: String, val offset: Int)
data class NextHint(val file: String, val offset: Int, val reason: String)
```

### 3.2 触发与生命周期

```
[idle]
  └─ user types / cursor moves
     └─ debounce 80ms
        └─ predict(context) → TabSuggestion
           └─ render ghost (multi-line, multi-file marker)
              ├─ Tab → accept(suggestion.id)
              │   ├─ apply edits
              │   ├─ jump cursor → cursorAfter
              │   └─ if nextSuggestionHint → predict again immediately (no debounce)
              ├─ Esc → dismiss('user')
              ├─ Type any → dismiss('type-out') (if input doesn't match prefix)
              └─ Move cursor far → dismiss('cursor-move')
```

## 4. 后端

### 4.1 TabPredictionService

`plugin/src/main/kotlin/io/codepilot/plugin/completion/TabPredictionService.kt`:

```kotlin
@Service(Service.Level.PROJECT)
class TabPredictionService(private val project: Project) {
  private val bus get() = project.getService(EventBus::class.java)
  private val cache = Caffeine.newBuilder().maximumSize(64).build<String, TabSuggestion>()

  suspend fun predict(req: PredictRequest): TabSuggestion? {
    val key = req.cacheKey()
    cache.getIfPresent(key)?.let { return it }
    val t0 = System.currentTimeMillis()

    val ctx = buildContext(req)
    val raw = TabModel.complete(ctx)         // fast 模型,structured output
    val sug = parse(raw)?.also { cache.put(key, it) }

    bus.emit("system", "tab-${sug?.id ?: t0}", "tab.suggest", mapOf(
      "id" to sug?.id, "file" to req.file, "latency" to (System.currentTimeMillis() - t0),
      "lines" to (sug?.edits?.sumOf { it.newText.count { c -> c == '\n' } + 1 } ?: 0),
      "confidence" to sug?.confidence,
    ))
    return sug
  }

  fun reportAccept(id: String, durationToAcceptMs: Long) =
    bus.emit("system", "tab-acc-$id", "tab.accept",
      mapOf("id" to id, "ttaMs" to durationToAcceptMs))

  fun reportDismiss(id: String, reason: String) =
    bus.emit("system", "tab-dis-$id", "tab.dismiss",
      mapOf("id" to id, "reason" to reason))

  private fun buildContext(req: PredictRequest): TabContext {
    return TabContext(
      filePath = req.file,
      beforeCursor = readSlice(req.file, max(0, req.offset - 2000), req.offset),
      afterCursor  = readSlice(req.file, req.offset, req.offset + 1000),
      recentEdits  = RecentEditTracker.lastN(20),
      relatedFiles = RelatedFileFinder.find(req.file, k = 3).map { readWithRange(it) },
      languageId   = detectLanguage(req.file),
    )
  }
}

data class PredictRequest(val file: String, val offset: Int, val typedSinceLastPredict: String) {
  fun cacheKey() = "$file:$offset:${typedSinceLastPredict.hashCode()}"
}
```

### 4.2 模型 prompt 草稿

```
You are a code completion engine. Predict the user's next 1-N edits.

File: <path>  (language: <lang>)
<before cursor 100 lines>
<CURSOR/>
<after cursor 30 lines>

Recent edits:
- <file>:<L>: replaced "..." with "..."
- ...

Related files (read-only context):
<file1 with relevant region>
<file2 with relevant region>

Return JSON:
{
  "edits": [
    { "file": "<path>", "range": [start, end], "newText": "...", "kind": "INSERT|REPLACE|DELETE|MOVE" }
  ],
  "cursorAfter": { "file": "...", "offset": N },
  "nextSuggestionHint": { "file": "...", "offset": N, "reason": "..." } | null,
  "confidence": 0.0~1.0
}
```

约束:`edits` 数量 ≤ 5,跨文件 ≤ 2 个文件,总新增字符 ≤ 1200。

### 4.3 RecentEditTracker

记录每次文档变更:

```kotlin
@Service(Service.Level.PROJECT)
class RecentEditTracker(project: Project) : DocumentListener {
  private val ring = ArrayDeque<Edit>(50)
  init {
    EditorFactory.getInstance().eventMulticaster.addDocumentListener(this, project)
  }
  override fun documentChanged(e: DocumentEvent) {
    val file = FileDocumentManager.getInstance().getFile(e.document)?.path ?: return
    ring.addLast(Edit(file = file,
      range = TextRange(e.offset, e.offset + e.oldLength),
      newText = e.newFragment.toString(), kind = EditKind.REPLACE))
    while (ring.size > 50) ring.removeFirst()
  }
  fun lastN(n: Int) = ring.toList().takeLast(n)
}
```

### 4.4 RelatedFileFinder

基于:

1. 当前文件 import / require 出去的本地文件
2. `LocalSearchEngine.semanticSearch(currentSymbolNeighborhood)` 的 top-3
3. 最近 5 分钟编辑过的文件

## 5. Editor 集成(IntelliJ)

IntelliJ 原生 `InlineCompletionProvider` 只能渲染单段;**多行 + 跳跃**需要
自定义渲染:

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/completion/TabRenderer.kt
@Service(Service.Level.PROJECT)
class TabRenderer(private val project: Project) {
  private val activeByEditor = ConcurrentHashMap<Editor, ActiveSuggestion>()

  data class ActiveSuggestion(
    val id: String, val suggestion: TabSuggestion,
    val inlays: List<Inlay<*>>, val highlighters: List<RangeHighlighter>,
    val shownAt: Long,
  )

  fun show(editor: Editor, sug: TabSuggestion) {
    dismiss(editor, "replaced")
    val inlays = mutableListOf<Inlay<*>>()
    val hls = mutableListOf<RangeHighlighter>()
    sug.edits.filter { it.file == editor.virtualFile?.path }.forEach { ed ->
      when (ed.kind) {
        EditKind.INSERT -> {
          inlays.add(editor.inlayModel.addInlineElement(ed.range.startOffset, true,
            GhostTextRenderer(ed.newText, multiline = ed.newText.contains('\n')))!!)
        }
        EditKind.REPLACE -> {
          // 把要替换的范围画上"删除态"
          val attr = TextAttributes(null, JBColor(Color(255,80,80,40), Color(120,40,40,80)), null, null, 0)
          hls.add(editor.markupModel.addRangeHighlighter(
            ed.range.startOffset, ed.range.endOffset,
            HighlighterLayer.SELECTION + 1, attr, HighlighterTargetArea.EXACT_RANGE))
          inlays.add(editor.inlayModel.addInlineElement(ed.range.endOffset, true,
            GhostTextRenderer(ed.newText, multiline = ed.newText.contains('\n')))!!)
        }
        EditKind.DELETE -> {
          val attr = TextAttributes(null, JBColor(Color(255,80,80,60), Color(120,40,40,100)), null, null, 0)
          hls.add(editor.markupModel.addRangeHighlighter(
            ed.range.startOffset, ed.range.endOffset,
            HighlighterLayer.SELECTION + 1, attr, HighlighterTargetArea.EXACT_RANGE))
        }
        EditKind.MOVE -> { /* render as delete + insert at target */ }
      }
    }
    // 跨文件的 edit:显示一个小角标提示 "Tab will also edit 2 other files"
    if (sug.edits.any { it.file != editor.virtualFile?.path }) {
      val n = sug.edits.count { it.file != editor.virtualFile?.path }
      inlays.add(editor.inlayModel.addInlineElement(editor.caretModel.offset, true,
        BadgeRenderer("+ $n more file edits"))!!)
    }
    activeByEditor[editor] = ActiveSuggestion(sug.id, sug, inlays, hls, System.currentTimeMillis())
  }

  fun accept(editor: Editor): Boolean {
    val a = activeByEditor[editor] ?: return false
    WriteAction.runAndWait<RuntimeException> {
      // 按 file 分组应用
      a.suggestion.edits.groupBy { it.file }.forEach { (file, edits) ->
        val doc = openDoc(file)
        edits.sortedByDescending { it.range.startOffset }.forEach { e ->
          when (e.kind) {
            EditKind.INSERT  -> doc.insertString(e.range.startOffset, e.newText)
            EditKind.REPLACE -> doc.replaceString(e.range.startOffset, e.range.endOffset, e.newText)
            EditKind.DELETE  -> doc.deleteString(e.range.startOffset, e.range.endOffset)
            EditKind.MOVE    -> { /* delete + insert */ }
          }
        }
      }
      a.suggestion.cursorAfter?.let { jumpTo(it) }
    }
    project.getService(TabPredictionService::class.java)
      .reportAccept(a.id, System.currentTimeMillis() - a.shownAt)
    cleanup(a)
    activeByEditor.remove(editor)

    // 链式预测
    a.suggestion.nextSuggestionHint?.let { hint ->
      coroutineScope.launch {
        val sug = project.getService(TabPredictionService::class.java)
          .predict(PredictRequest(hint.file, hint.offset, ""))
        sug?.let { show(focusedEditor(hint.file), it) }
      }
    }
    return true
  }

  fun dismiss(editor: Editor, reason: String) {
    val a = activeByEditor.remove(editor) ?: return
    project.getService(TabPredictionService::class.java).reportDismiss(a.id, reason)
    cleanup(a)
  }

  private fun cleanup(a: ActiveSuggestion) {
    a.inlays.forEach { it.dispose() }
    a.highlighters.forEach { it.dispose() }
  }
}
```

### 5.1 触发钩子

注册 `EditorFactory.getInstance().addEditorFactoryListener` + `DocumentListener` +
`CaretListener`:

```kotlin
class TabTriggerListener : DocumentListener, CaretListener {
  private val debouncer = Debouncer(80)
  override fun documentChanged(e: DocumentEvent) = trigger(e.editor)
  override fun caretPositionChanged(e: CaretEvent) {
    // 光标小幅移动不 dismiss(在建议范围内仍保留);大幅则 dismiss
    val active = TabRenderer.get(project).activeFor(e.editor)
    if (active != null && farFromSuggestion(e, active)) {
      TabRenderer.get(project).dismiss(e.editor, "cursor-move")
    }
    trigger(e.editor)
  }
  private fun trigger(editor: Editor) {
    debouncer.run {
      coroutineScope.launch {
        val sug = service.predict(PredictRequest(editor.virtualFile.path, editor.caretModel.offset, ""))
        sug?.let { TabRenderer.get(project).show(editor, it) }
      }
    }
  }
}
```

### 5.2 快捷键

注册 Action `CodePilot.Tab.Accept`,shortcut = `Tab`,但**仅当有 active
suggestion 时 enabled**,否则交还原生 Tab(缩进)。

```xml
<action id="CodePilot.Tab.Accept" class="...TabAcceptAction" text="Accept CodePilot Suggestion">
  <keyboard-shortcut keymap="$default" first-keystroke="TAB"/>
</action>
```

```kotlin
class TabAcceptAction : EditorAction(TabAcceptHandler())
class TabAcceptHandler : EditorActionHandler() {
  override fun isEnabledForCaret(editor: Editor, caret: Caret, context: DataContext): Boolean =
    TabRenderer.get(editor.project!!).activeFor(editor) != null
  override fun doExecute(editor: Editor, caret: Caret?, context: DataContext) {
    if (!TabRenderer.get(editor.project!!).accept(editor)) {
      // pass through to default tab handling
      EditorActionManager.getInstance().getActionHandler("EditorTab").execute(editor, caret, context)
    }
  }
}
```

Esc:`CodePilot.Tab.Dismiss`,同样仅 active 时 enabled。

## 6. 服务端节流与配额

- 客户端 80ms debounce + cache(`file:offset:typed`)。
- 服务端按用户级 RPM 限流(如 fast tier 600 rpm)。
- 接受率 < 5% 的用户自动降级建议频率(每 200ms 1 次)。

## 7. 反馈面板

延续 `04-inline-edit.md` 的 `TabSettingsPanel`,扩展指标:

- 多行接受率 / 单行接受率
- 链式接受深度直方图(1/2/3+)
- 跨文件接受率
- 每千行节省字符估算(基于接受的 `newText.length`)

## 8. 验收

1. 输入 `if (user.is`,模型预测多行:
   ```
   if (user.isAdmin) {
     return forbidden();
   }
   ```
   Tab 一次性接受全部 3 行。
2. 接受后,`cursorAfter` 把光标跳到下一函数的空缺处,且立即弹出下一个建议
   (链式)。
3. 用户大幅移动光标(跨 20+ 行)→ 当前建议自动 dismiss(reason=cursor-move),
   接受率指标不计。
4. 跨文件建议:在 `a.ts` 改 schema 时,建议显示 "+ 2 more file edits",
   接受后 `b.ts` / `c.ts` 同步被改。
5. 网络 / 模型错误 → 静默失败,**不打断**用户输入(只发 `tab.suggest.error`
   到 ConsolePanel,无 UI 噪音)。
