# 04 — 内联编辑 (Cmd+K) 与 Tab 补全反馈(P0) ✅ Completed

> **成熟度**: 见 [STATUS.md](./STATUS.md)（Designed / Implemented / Integrated / Productized）


> 已实现:
> - `inline/InlineEditAction` + `Accept/Reject/Rewrite` 三个绑定到
>   `Cmd/Ctrl+K`、`Alt+Y/N/R` 的 IDE Action(`plugin.xml` 注册)。
> - `inline/InlineEditController`(Project 服务):弹窗采集意图 → SSE 拉
>   `/v1/actions/inline-edit` → 流式追加到 `InlineEditSession.proposedBuffer`,
>   `InlineDiffInlayRenderer` 行内绘制 `+` 提案。Accept 通过 `PatchStaging.stage` +
>   `setAllHunks(ACCEPTED)` + `applyFile` 提交,与 P0-03 共用暂存区与撤销链。
> - `completion/TabFeedback`(Application 服务)+ Provider 钩子:`tab.suggest`
>   事件 + 接受率/平均延迟统计;新增 `EventTypes.TAB_*` 与 `INLINE_*`。
> - `CefChatPanel.handleTabGetStats/handleTabResetStats` 暴露统计端点。
> - WebUI `components/inline/{TabSettingsPanel,InlineEditTimeline}.tsx` 订阅
>   envelope + `tab.stats_response` 渲染设置面板和历史。
> - 测试 `TabFeedbackTest.kt` 覆盖计数器、接受率、reset、负延迟过滤。
> - 待接服务端 `/v1/actions/inline-edit` 端点(可复用 ActionBase 模式,prompt
>   见 `streamReplacement`)。


## 1. 目标

让用户**不离开编辑器**即可触发"选中代码 → 描述意图 → 看到内联 diff → Accept"。
对齐 Cursor 的 `Cmd+K` 体验。同时把已有的 `CodePilotInlineCompletionProvider`
(Tab 补全)接入显式反馈通道。

## 2. 现状

- `plugin/src/main/kotlin/io/codepilot/plugin/completion/CodePilotInlineCompletionProvider.kt`
  已经存在,但 WebUI 没有接受率/触发率/启停等反馈面板。
- 没有 `Cmd+K`:`CodePilotKeymap.kt` 没有 inline edit action。
- 选中代码后右键只能 `Add to Chat` → 走 chips 流程,**不就地展示 diff**。

## 3. Cmd+K 设计

### 3.1 触发与 UI

新增 IntelliJ Action `InlineEditAction`:

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/inline/InlineEditAction.kt
package io.codepilot.plugin.inline

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

class InlineEditAction : AnAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val editor = e.getData(CommonDataKeys.EDITOR) ?: return
    val project = e.project ?: return
    val sel = editor.selectionModel
    val range = if (sel.hasSelection())
      sel.selectionStart to sel.selectionEnd
    else
      // 默认选当前函数:用 PsiTreeUtil 查找包围方法
      InlineRangeHelper.enclosingFunctionRange(editor)
        ?: (editor.caretModel.offset.let { it to it })
    InlineEditController.getInstance(project).open(editor, range.first, range.second)
  }
}
```

`plugin.xml`:

```xml
<action id="CodePilot.InlineEdit"
        class="io.codepilot.plugin.inline.InlineEditAction"
        text="CodePilot Inline Edit">
  <keyboard-shortcut keymap="$default" first-keystroke="control K"/>
  <keyboard-shortcut keymap="Mac OS X 10.5+" first-keystroke="meta K"/>
</action>
```

### 3.2 InlineEditController

负责:在选中区域上方插入一个内联浮层(IntelliJ `JBPopup` + 自定义
`EditorCustomElementRenderer`),浮层是一个 mini 输入框 + 进度 + Accept/Reject。

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/inline/InlineEditController.kt
package io.codepilot.plugin.inline

import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import io.codepilot.plugin.apply.PatchStaging
import io.codepilot.plugin.conversation.ConversationClient
import java.awt.Color
import javax.swing.JTextField

@Service(Service.Level.PROJECT)
class InlineEditController(private val project: Project) {
  companion object { fun getInstance(p: Project) = p.getService(InlineEditController::class.java) }

  fun open(editor: Editor, start: Int, end: Int) {
    val file = editor.virtualFile ?: return
    val original = editor.document.getText(com.intellij.openapi.util.TextRange(start, end))
    val input = JTextField()
    val popup = JBPopupFactory.getInstance().createComponentPopupBuilder(input, input)
      .setTitle("Inline Edit — 描述你的修改意图(Enter 提交,Esc 取消)")
      .setMovable(true).setResizable(true).setRequestFocus(true)
      .createPopup()
    input.addActionListener {
      popup.cancel()
      val intent = input.text
      submit(editor, file.path, original, start, end, intent)
    }
    // 在选区下方弹
    val pos = editor.offsetToVisualPosition(end)
    val point = editor.visualPositionToXY(pos)
    popup.show(com.intellij.ui.awt.RelativePoint(editor.contentComponent, point))
    highlightRange(editor, start, end)
  }

  private fun submit(editor: Editor, path: String, original: String,
                     start: Int, end: Int, intent: String) {
    val turnId = "inline-${System.nanoTime()}"
    val client = ConversationClient.getInstance(project)
    client.inlineEdit(turnId, InlineEditRequest(
      filePath = path, range = start to end, original = original, intent = intent,
    )) { newText ->
      // newText 由 LLM 流式返回的目标内容
      val staging = project.getService(PatchStaging::class.java)
      val fullDoc = editor.document.text
      val proposed = fullDoc.substring(0, start) + newText + fullDoc.substring(end)
      val pf = staging.stage(turnId, path, "replace", fullDoc, proposed)
      // 在编辑器中直接画 inline diff(下一节)
      InlineDiffRenderer.show(editor, start, end, original, newText, pf.pendingId)
    }
  }

  private fun highlightRange(editor: Editor, start: Int, end: Int) {
    val attrs = TextAttributes(null, Color(255, 255, 0, 30), null, null, 0)
    editor.markupModel.addRangeHighlighter(
      start, end, HighlighterLayer.SELECTION - 1, attrs, HighlighterTargetArea.EXACT_RANGE)
  }
}

data class InlineEditRequest(
  val filePath: String, val range: Pair<Int, Int>,
  val original: String, val intent: String,
)
```

### 3.3 InlineDiffRenderer

在编辑器 gutter / 行内绘制 diff,提供按钮:

```kotlin
// plugin/src/main/kotlin/io/codepilot/plugin/inline/InlineDiffRenderer.kt
package io.codepilot.plugin.inline

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.TextAttributes
import io.codepilot.plugin.apply.PatchStaging
import java.awt.Color

object InlineDiffRenderer {
  /** 在选区范围画"删除态"(灰删除线),并在下方插 inlay 显示"新增内容 + 按钮" */
  fun show(editor: Editor, start: Int, end: Int,
           original: String, proposed: String, pendingId: String) {
    val delAttr = TextAttributes(null, Color(255, 80, 80, 40), null, null, 0)
    val highlighter = editor.markupModel.addRangeHighlighter(
      start, end, HighlighterLayer.SELECTION + 1, delAttr, HighlighterTargetArea.EXACT_RANGE)

    val insertOffset = end
    val inlay = editor.inlayModel.addBlockElement(
      insertOffset, /*relatesToPrecedingText*/ true, /*showAbove*/ false, /*priority*/ 0,
      InlineDiffInlayRenderer(proposed) { action ->
        when (action) {
          "accept" -> {
            project(editor).getService(PatchStaging::class.java).apply(pendingId)
            cleanup(highlighter, inlay)
          }
          "reject" -> {
            project(editor).getService(PatchStaging::class.java).list()
              .firstOrNull { it.pendingId == pendingId }
              ?.hunks?.forEach { it.status = io.codepilot.plugin.apply.HunkStatus.REJECTED }
            cleanup(highlighter, inlay)
          }
          "rewrite" -> {
            // 重新打开输入框,intent 替换
            InlineEditController.getInstance(project(editor)).open(editor, start, end)
            cleanup(highlighter, inlay)
          }
        }
      },
    )
  }
  private fun project(editor: Editor) = editor.project!!
  private fun cleanup(h: com.intellij.openapi.editor.markup.RangeHighlighter, i: Inlay<*>?) {
    h.dispose(); i?.dispose()
  }
}
```

`InlineDiffInlayRenderer` 是一个 `EditorCustomElementRenderer`,绘制:

- 顶部一行:`+++ 新内容` 标识
- 中间:proposed 文本(浅绿背景,等宽字体)
- 底部按钮条:`✓ Accept (⌥Y)` `✗ Reject (⌥N)` `↻ Rewrite (⌥R)`

```kotlin
package io.codepilot.plugin.inline

import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.markup.TextAttributes
import java.awt.Color
import java.awt.Graphics
import java.awt.Rectangle

class InlineDiffInlayRenderer(
  private val proposed: String,
  private val onAction: (String) -> Unit,
) : EditorCustomElementRenderer {
  override fun calcWidthInPixels(inlay: Inlay<*>): Int = inlay.editor.scrollingModel.visibleArea.width
  override fun calcHeightInPixels(inlay: Inlay<*>): Int {
    val lines = proposed.count { it == '\n' } + 1
    return lines * inlay.editor.lineHeight + 28 /* button bar */
  }
  override fun paint(inlay: Inlay<*>, g: Graphics, region: Rectangle, attrs: TextAttributes) {
    val ed = inlay.editor
    g.color = Color(80, 200, 120, 30)
    g.fillRect(region.x, region.y, region.width, region.height - 28)
    g.color = Color(80, 200, 120)
    g.font = ed.colorsScheme.getFont(com.intellij.openapi.editor.colors.EditorFontType.PLAIN)
    val lh = ed.lineHeight
    proposed.split("\n").forEachIndexed { i, line ->
      g.drawString("+ $line", region.x + 8, region.y + (i + 1) * lh - 4)
    }
    // 按钮条由独立的 JComponent 覆盖,见 register()(略;实际可用 Inlay + JComponent overlay)
  }
}
```

> 实施提示:按钮交互建议用 `EditorComponentImpl.add(panel)` 把一个
> `JPanel` 浮层挂到编辑器内容层,绝对定位到 inlay 底部 24px 高度。`AltY/AltN/
> AltR` 通过 `EditorActionHandler` 注册,scope 限定为"存在 inline-diff 实例时"。

### 3.4 流式 newText 获取

`ConversationClient.inlineEdit` 内部:

```kotlin
fun inlineEdit(turnId: String, req: InlineEditRequest, onChunk: (String) -> Unit) {
  val prompt = """
    File: ${req.filePath}
    Selected range: lines around offset ${req.range.first}-${req.range.second}
    Original:
    ```
    ${req.original}
    ```
    Instruction: ${req.intent}
    Return ONLY the replacement code (no markdown fences, no commentary).
  """.trimIndent()

  // 使用 fast 模型 + JSON 模式关闭;复用现有 SSE 客户端
  val buf = StringBuilder()
  sse.stream(SseRequest(prompt = prompt, mode = "inline-edit", modelHint = "fast")).collect { ch ->
    if (ch is SseChunk.TextDelta) {
      buf.append(ch.text)
      // 实时推流给前端,渲染"打字机"效果
      bus.emit(turnId, turnId, "inline.delta",
        mapOf("text" to ch.text, "filePath" to req.filePath))
    }
    if (ch is SseChunk.Done) {
      val cleaned = stripCodeFences(buf.toString())
      onChunk(cleaned)
      bus.emit(turnId, turnId, "inline.done", mapOf("text" to cleaned))
    }
  }
}

private fun stripCodeFences(s: String): String {
  val r = Regex("^```[a-zA-Z]*\\n([\\s\\S]*?)\\n```\$")
  return r.find(s.trim())?.groupValues?.get(1) ?: s.trim()
}
```

### 3.5 WebUI 同步显示(可选)

WebUI 的 ChatView 也展示一个 "Inline Edit · file.kt:L120-L140 · accepted" 卡片,
便于历史回溯。事件:

```ts
case 'inline.done': {
  // 在 chat 区追加一个 system-info 卡:点击可定位到那次编辑的 pendingId
  return appendSystemEvent(state, ev);
}
```

## 4. Tab 补全反馈面板

### 4.1 后端发埋点

在 `CodePilotInlineCompletionProvider.kt` 现有逻辑里加 hook:

```kotlin
class CodePilotInlineCompletionProvider : InlineCompletionProvider {
  private val bus get() = project.getService(EventBus::class.java)

  override suspend fun getProposals(request: InlineCompletionRequest): InlineCompletionSuggestion {
    val t0 = System.currentTimeMillis()
    val proposals = fetch(request)
    bus.emit("tab", "tab-${t0}", "tab.suggest", mapOf(
      "file" to request.file.path, "line" to request.startOffset,
      "len" to proposals.firstOrNull()?.text?.length, "latency" to (System.currentTimeMillis() - t0),
    ))
    return proposals
  }

  // 在 accept handler 中:
  fun onAccept(text: String, file: String) =
    bus.emit("tab", "tab-${System.nanoTime()}", "tab.accept",
      mapOf("file" to file, "len" to text.length))

  fun onDismiss(reason: String) =
    bus.emit("tab", "tab-${System.nanoTime()}", "tab.dismiss", mapOf("reason" to reason))
}
```

### 4.2 WebUI 设置面板

新增 `plugin/webui/src/components/inline/TabSettingsPanel.tsx`:

```tsx
export function TabSettingsPanel() {
  const stats = useChatStore(s => s.tabStats);  // 由 envelope 累加
  return (
    <div className="tab-settings">
      <h3>代码补全</h3>
      <label>
        <input type="checkbox" checked={stats.enabled}
          onChange={e => sendToPlugin('tab.set_enabled', { enabled: e.target.checked })} />
        启用 Tab 补全
      </label>
      <div className="tab-stats">
        <div>建议数:{stats.suggestCount}</div>
        <div>接受数:{stats.acceptCount}</div>
        <div>接受率:{(stats.acceptCount / Math.max(1, stats.suggestCount) * 100).toFixed(1)}%</div>
        <div>平均延迟:{stats.avgLatency}ms</div>
      </div>
      <label>
        触发字符数阈值:
        <input type="number" min={1} max={20} defaultValue={stats.minChars}
          onBlur={e => sendToPlugin('tab.set_min_chars', { value: +e.target.value })} />
      </label>
    </div>
  );
}
```

Store 中累加:

```ts
case 'tab.suggest': stats.suggestCount++; stats.latencyTotal += ev.payload.latency; break;
case 'tab.accept':  stats.acceptCount++; break;
case 'tab.dismiss': stats.dismissCount++; break;
```

## 5. 键盘快捷键

| 动作 | 快捷键 | 实现位置 |
|---|---|---|
| Inline Edit | Ctrl/Cmd+K | `plugin.xml` action |
| Accept inline diff | Alt+Y | `AcceptInlineAction` 仅在 InlineDiffRenderer 存在时 enabled |
| Reject inline diff | Alt+N | 同上 |
| Rewrite | Alt+R | 同上 |
| Open Chat | Ctrl/Cmd+L | 复用已有 `OpenChatAction` |
| Send selection to Chat | Ctrl/Cmd+Shift+L | 新增 action,调 `context_added` |

## 6. 验收

1. 文件中选 10 行,Cmd+K → 输入 "改成 async/await" → 浮层显示流式生成 →
   Alt+Y 后文件实际内容为新版本,Undo all AI changes 可还原。
2. 无选区时按 Cmd+K,默认选中"光标所在函数体"。
3. Tab 补全数据在 WebUI Settings 面板实时刷新,接受率随真实操作变化。
4. inline edit 与 `PatchStaging` 共用同一 staging 区,可在 ChangePanel 也看到这次
   pending(便于和别的工具生成的改动一起 review)。
