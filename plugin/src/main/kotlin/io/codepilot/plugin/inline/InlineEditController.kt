package io.codepilot.plugin.inline

import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.awt.RelativePoint
import io.codepilot.plugin.apply.PatchStaging
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.swing.BorderFactory
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.SwingConstants

/**
 * P0-04 — Inline Edit (Cmd+K) controller. Holds at most one [InlineEditSession]
 * per [Editor] instance and coordinates:
 *
 *  - the intent-input popup
 *  - the SSE call against `/v1/actions/inline-edit` (reusing the existing actions
 *    backend; the server prompt should return raw replacement code with no
 *    markdown fences)
 *  - streaming updates to the [InlineDiffInlayRenderer]
 *  - accept / reject / rewrite handed through [PatchStaging] so the change shows
 *    up in the v2 ChangePanel as well.
 */
@Service(Service.Level.PROJECT)
class InlineEditController(private val project: Project) {
    private val log = logger<InlineEditController>()
    private val mapper = ObjectMapper()
    private val sessions = ConcurrentHashMap<Editor, InlineEditSession>()
    private val sources = ConcurrentHashMap<String, EventSource>()

    /** Public entry point: a Cmd+K action calls this with the user's selection. */
    fun open(editor: Editor, startOffset: Int, endOffset: Int) {
        if (sessions.containsKey(editor)) {
            // Already showing an inline edit; ignore the second invocation so we
            // don't end up with two overlapping inlays.
            return
        }
        val doc = editor.document
        val safeStart = startOffset.coerceIn(0, doc.textLength)
        val safeEnd = endOffset.coerceIn(safeStart, doc.textLength)
        val original = doc.getText(com.intellij.openapi.util.TextRange(safeStart, safeEnd))
        val vf = editor.virtualFile
        val filePath = vf?.path?.removePrefix(project.basePath ?: "")?.removePrefix("/") ?: "<buffer>"

        promptForIntent(editor) { intent ->
            if (intent.isBlank()) return@promptForIntent
            startSession(editor, filePath, safeStart, safeEnd, original, intent)
        }
    }

    fun sessionFor(editor: Editor): InlineEditSession? = sessions[editor]

    fun accept(editor: Editor) {
        val s = sessions[editor] ?: return
        if (s.status == InlineEditSession.Status.STREAMING || s.status == InlineEditSession.Status.FAILED) {
            // Streaming: cancel SSE and accept whatever buffered text exists; failed: no-op.
            if (s.status == InlineEditSession.Status.STREAMING) {
                sources.remove(s.turnId)?.cancel()
            } else {
                dismiss(editor, InlineEditSession.Status.REJECTED)
                return
            }
        }
        val fullDoc = editor.document.text
        val proposedDoc = fullDoc.substring(0, s.startOffset) +
            s.proposedText +
            fullDoc.substring(s.endOffset)
        val staging = PatchStaging.getInstance(project)
        val pendingId = staging.stage(
            turnId = s.turnId,
            path = s.filePath,
            newContent = proposedDoc,
            op = PatchStaging.Op.WRITE,
        )
        staging.setAllHunks(pendingId, PatchStaging.HunkStatus.ACCEPTED)
        val result = staging.applyFile(pendingId)
        emit(s.turnId, EventTypes.INLINE_ACCEPT, mapOf(
            "filePath" to s.filePath,
            "pendingId" to pendingId,
            "applied" to (result["ok"] == true),
        ))
        s.status = InlineEditSession.Status.ACCEPTED
        cleanup(editor)
    }

    fun reject(editor: Editor) {
        val s = sessions[editor] ?: return
        sources.remove(s.turnId)?.cancel()
        emit(s.turnId, EventTypes.INLINE_REJECT, mapOf("filePath" to s.filePath))
        dismiss(editor, InlineEditSession.Status.REJECTED)
    }

    fun rewrite(editor: Editor) {
        val s = sessions[editor] ?: return
        val start = s.startOffset
        val end = s.endOffset
        reject(editor)
        // Reopen the popup so the user can submit a new intent.
        open(editor, start, end)
    }

    // ---------------- Internals ---------------- //

    private fun promptForIntent(editor: Editor, onSubmit: (String) -> Unit) {
        val field = JTextField()
        field.preferredSize = Dimension(480, 28)
        val panel = JPanel(BorderLayout(0, 4)).apply {
            border = BorderFactory.createEmptyBorder(6, 8, 6, 8)
            add(JLabel("CodePilot Inline Edit  —  描述意图,Enter 提交,Esc 取消", SwingConstants.LEFT), BorderLayout.NORTH)
            add(field, BorderLayout.CENTER)
            preferredSize = Dimension(520, 64)
        }
        val popup = JBPopupFactory.getInstance().createComponentPopupBuilder(panel, field)
            .setMovable(true)
            .setResizable(true)
            .setRequestFocus(true)
            .setCancelOnClickOutside(true)
            .setCancelOnWindowDeactivation(true)
            .createPopup()
        field.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_ENTER -> {
                        val text = field.text.trim()
                        popup.cancel()
                        if (text.isNotEmpty()) onSubmit(text)
                    }
                    KeyEvent.VK_ESCAPE -> popup.cancel()
                }
            }
        })
        val pos = editor.offsetToVisualPosition(editor.caretModel.offset)
        val point = editor.visualPositionToXY(pos)
        popup.show(RelativePoint(editor.contentComponent, point))
    }

    private fun startSession(
        editor: Editor,
        filePath: String,
        startOffset: Int,
        endOffset: Int,
        original: String,
        intent: String,
    ) {
        val turnId = "inline-${UUID.randomUUID().toString().take(8)}"
        val session = InlineEditSession(
            turnId = turnId,
            editor = editor,
            filePath = filePath,
            startOffset = startOffset,
            endOffset = endOffset,
            originalText = original,
        )
        sessions[editor] = session

        // Highlight the range being replaced (soft red) and add a block inlay below it.
        val delAttr = TextAttributes(null, Color(220, 80, 80, 36), null, null, 0)
        session.highlighter = editor.markupModel.addRangeHighlighter(
            startOffset,
            endOffset,
            HighlighterLayer.SELECTION + 1,
            delAttr,
            HighlighterTargetArea.EXACT_RANGE,
        )
        val renderer = InlineDiffInlayRenderer(session)
        session.inlay = editor.inlayModel.addBlockElement(
            endOffset,
            /*relatesToPrecedingText*/ true,
            /*showAbove*/ false,
            /*priority*/ 0,
            renderer,
        )

        emit(turnId, EventTypes.INLINE_OPEN, mapOf(
            "filePath" to filePath,
            "startOffset" to startOffset,
            "endOffset" to endOffset,
            "intent" to intent,
        ))

        streamReplacement(session, intent)
    }

    private fun streamReplacement(s: InlineEditSession, intent: String) {
        val settings = CodePilotSettings.getInstance()
        val http = HttpClientService.getInstance()
        val url = settings.state.backendBaseUrl.trimEnd('/') + "/v1/actions/inline-edit"
        val ctx = gatherEditorContext(s)
        val body = mapper.writeValueAsString(mapOf(
            "sessionId" to UUID.randomUUID().toString(),
            // P0 audit fix — when the original selection is blank (pure
            // "generate" case from Cmd+K on an empty line), the server-side
            // record requires @NotBlank, so we ship a single space. The server
            // detects whitespace-only and routes to the generate prompt.
            "selection" to s.originalText.ifBlank { " " },
            "instruction" to intent,
            "filePath" to s.filePath,
            "language" to languageHint(s.filePath),
            // Cursor-style extended context (all optional on the server side):
            "prefixContext" to ctx.prefix,
            "suffixContext" to ctx.suffix,
            "fileOutline" to ctx.outline,
            "cursorOffset" to ctx.cursorOffset,
            "diagnostics" to ctx.diagnostics,
        ))
        val request = Request.Builder()
            .url(url)
            .post(body.toRequestBody("application/json".toMediaType()))
            .header("Accept", "text/event-stream")
            .build()

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val listener = object : EventSourceListener() {
                    override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                        val node = mapper.readTree(data.ifEmpty { "{}" })
                        when (type) {
                            "delta" -> {
                                val text = node.path("text").asText("")
                                if (text.isNotEmpty()) appendDelta(s, text)
                            }
                            "done" -> finishStream(s, true, node.path("reason").asText("final"))
                            "error" -> finishStream(s, false, node.path("message").asText("error"))
                        }
                    }
                    override fun onClosed(eventSource: EventSource) {
                        if (s.status == InlineEditSession.Status.STREAMING) finishStream(s, true, "closed")
                    }
                    override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                        response?.close()
                        finishStream(s, false, t?.message ?: "sse failed")
                    }
                }
                sources[s.turnId] = http.openSse(request, listener)
            } catch (t: Throwable) {
                log.warn("inline-edit SSE failed: ${t.message}", t)
                finishStream(s, false, t.message ?: "open failed")
            }
        }
    }

    private fun appendDelta(s: InlineEditSession, text: String) {
        ApplicationManager.getApplication().invokeLater {
            s.proposedBuffer.append(text)
            s.inlay?.let { it.update() }
            emit(s.turnId, EventTypes.INLINE_DELTA, mapOf("filePath" to s.filePath, "text" to text))
        }
    }

    private fun finishStream(s: InlineEditSession, ok: Boolean, reason: String) {
        ApplicationManager.getApplication().invokeLater {
            sources.remove(s.turnId)
            if (!ok) {
                s.status = InlineEditSession.Status.FAILED
                emit(s.turnId, EventTypes.INLINE_ERROR, mapOf("filePath" to s.filePath, "reason" to reason))
            } else {
                // The server prompt (prompts/action.inline-edit.txt) returns
                // strict JSON: {oldText, newText, explanation}. We parse that
                // here and reduce the buffer to the final replacement text the
                // user should see in the inlay. Fall back to raw / fence-stripped
                // text if JSON parsing fails (older prompts or partial output).
                val parsed = extractReplacement(s.proposedBuffer.toString(), s.originalText)
                s.proposedBuffer.replace(0, s.proposedBuffer.length, parsed)
                s.status = InlineEditSession.Status.READY
                emit(s.turnId, EventTypes.INLINE_DONE, mapOf(
                    "filePath" to s.filePath,
                    "length" to s.proposedBuffer.length,
                ))
            }
            s.inlay?.update()
        }
    }

    /**
     * Reduce the raw model output to the replacement text that should fill the
     * user's original selection. Supports four formats, tried in order:
     *
     * 1. **Sentinel protocol** (new, current `action.inline-edit.txt`):
     *    `<replacement>\n<<<EXPLAIN>>>\n<explanation>`. The replacement is
     *    everything before the sentinel.
     * 2. **Abstain protocol**: `<<<NEEDS_INPUT>>>\n<question>`. We surface the
     *    question via the inline-edit error path and keep the original text.
     * 3. **Legacy JSON** `{oldText, newText, explanation}` — kept for
     *    compatibility with the old prompt template.
     * 4. **Markdown-fenced or plain text** — fences are stripped and trimmed.
     */
    private fun extractReplacement(raw: String, original: String): String {
        val trimmed = raw.trim()

        // 1. Sentinel protocol.
        val explainIdx = trimmed.indexOf("<<<EXPLAIN>>>")
        if (explainIdx >= 0) {
            return trimmed.substring(0, explainIdx).trimEnd('\r', '\n')
        }
        // 2. Abstain — keep the original text and let the FAILED status surface
        // the model's question; the renderer's bar already says "Failed".
        if (trimmed.startsWith("<<<NEEDS_INPUT>>>")) {
            return original
        }
        // 3. Legacy JSON fallback.
        if (trimmed.startsWith("{")) {
            try {
                val node = mapper.readTree(trimmed)
                val newText = node.path("newText").asText("")
                val oldText = node.path("oldText").asText("")
                if (newText.isNotEmpty()) {
                    return when {
                        oldText.isEmpty() -> newText
                        oldText == original -> newText
                        original.contains(oldText) -> original.replace(oldText, newText)
                        else -> newText
                    }
                }
            } catch (_: Throwable) {
                // Fall through.
            }
        }
        // 4. Fence-strip / plain text.
        return stripCodeFences(trimmed)
    }

    /**
     * Snapshot of editor context attached to every inline-edit request.
     * `prefix`/`suffix` are limited to ~30 lines (~1500 chars cap as safety)
     * to keep request size bounded; `outline` is a best-effort PSI summary;
     * `diagnostics` is the current file's IDE warnings/errors.
     */
    private data class EditorContext(
        val prefix: String,
        val suffix: String,
        val outline: String,
        val cursorOffset: Int,
        val diagnostics: List<String>,
    )

    private fun gatherEditorContext(s: InlineEditSession): EditorContext {
        val doc = s.editor.document
        val text = doc.text
        val prefix = sliceAroundLines(text, 0, s.startOffset, contextLines = 30, fromEnd = true)
        val suffix = sliceAroundLines(text, s.endOffset, text.length, contextLines = 30, fromEnd = false)
        val cursorOffset = (s.editor.caretModel.offset - s.startOffset).coerceAtLeast(-1)
        val outline = runCatching { computeOutline(s.editor) }.getOrDefault("")
        val diagnostics = runCatching { collectDiagnostics(s.editor) }.getOrDefault(emptyList())
        return EditorContext(prefix, suffix, outline, cursorOffset, diagnostics)
    }

    /**
     * Extract up to [contextLines] lines from `text[from, to)`. When
     * [fromEnd] is true we keep the last N lines (prefix context); otherwise
     * the first N (suffix context). Also caps total size at 4000 chars.
     */
    private fun sliceAroundLines(
        text: String,
        from: Int,
        to: Int,
        contextLines: Int,
        fromEnd: Boolean,
    ): String {
        if (from >= to) return ""
        val slice = text.substring(from.coerceAtLeast(0), to.coerceAtMost(text.length))
        val lines = slice.split('\n')
        val picked = if (fromEnd) lines.takeLast(contextLines) else lines.take(contextLines)
        val joined = picked.joinToString("\n")
        return if (joined.length > 4000) joined.substring(joined.length - 4000) else joined
    }

    private fun computeOutline(editor: com.intellij.openapi.editor.Editor): String {
        val vf = editor.virtualFile ?: return ""
        val psi = com.intellij.psi.PsiManager.getInstance(project).findFile(vf) ?: return ""
        // Walk top-level children and collect named declarations. Generic
        // enough to work across languages without requiring language modules
        // at compile time.
        val out = StringBuilder()
        var children = 0
        for (child in psi.children) {
            val nameNode = child.javaClass.simpleName
            if (nameNode.endsWith("Whitespace") || nameNode.endsWith("Comment")) continue
            val name = (child as? com.intellij.psi.PsiNamedElement)?.name
            val firstLine = child.text.lineSequence().firstOrNull()?.trim()?.take(120)
            if (!firstLine.isNullOrBlank()) {
                if (name != null) out.append("- ").append(name).append(": ").append(firstLine).append('\n')
                else out.append("- ").append(firstLine).append('\n')
                children++
                if (children >= 40) break
            }
        }
        return out.toString().trimEnd()
    }

    private fun collectDiagnostics(editor: com.intellij.openapi.editor.Editor): List<String> {
        val markup = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(
            editor.document, project, false,
        ) ?: return emptyList()
        val infos = mutableListOf<String>()
        for (h in markup.allHighlighters) {
            val diagnostic = highlightDiagnostic(h, editor) ?: continue
            infos.add(diagnostic)
            if (infos.size >= 20) break
        }
        return infos
    }

    /**
     * Prefer HighlightInfo carried by the highlighter (newer IntelliJ SDKs
     * expose it through `getHighlighterData()`), then fall back to the public
     * tooltip when the method is unavailable. Reflection keeps this source
     * compatible with older platform versions where that method is absent at
     * compile time.
     */
    private fun highlightDiagnostic(
        highlighter: com.intellij.openapi.editor.markup.RangeHighlighter,
        editor: com.intellij.openapi.editor.Editor,
    ): String? {
        val highlightInfo = runCatching {
            val method = highlighter.javaClass.methods.firstOrNull { it.name == "getHighlighterData" }
                ?: return@runCatching null
            method.invoke(highlighter)
        }.getOrNull()

        if (highlightInfo != null) {
            val severity = readHighlightSeverity(highlightInfo)
            if (severity != "ERROR" && severity != "WARNING") return null
            val startOffset = readIntProperty(highlightInfo, "getStartOffset")
                ?: readIntProperty(highlightInfo, "startOffset")
                ?: highlighter.startOffset
            val description = readStringProperty(highlightInfo, "getDescription")
                ?: readStringProperty(highlightInfo, "description")
                ?: ""
            val line = editor.document.getLineNumber(startOffset) + 1
            return "L$line [${severity.lowercase()}] $description"
        }

        val tooltip = highlighter.errorStripeTooltip?.toString()?.takeIf { it.isNotBlank() } ?: return null
        val line = editor.document.getLineNumber(highlighter.startOffset) + 1
        return "L$line [diagnostic] $tooltip"
    }

    private fun readHighlightSeverity(highlightInfo: Any): String? {
        val type = runCatching {
            highlightInfo.javaClass.methods.firstOrNull { it.name == "getType" }?.invoke(highlightInfo)
        }.getOrNull() ?: runCatching {
            highlightInfo.javaClass.fields.firstOrNull { it.name == "type" }?.get(highlightInfo)
        }.getOrNull()

        val severity = type?.let {
            runCatching {
                it.javaClass.methods.firstOrNull { m -> m.name == "getSeverity" }?.invoke(it)
            }.getOrNull() ?: runCatching {
                it.javaClass.fields.firstOrNull { f -> f.name == "severity" }?.get(it)
            }.getOrNull()
        } ?: runCatching {
            highlightInfo.javaClass.methods.firstOrNull { it.name == "getSeverity" }?.invoke(highlightInfo)
        }.getOrNull()

        return severity?.toString()?.substringAfterLast('.')?.uppercase()
    }

    private fun readIntProperty(instance: Any, name: String): Int? =
        runCatching {
            val method = instance.javaClass.methods.firstOrNull { it.name == name }
            method?.invoke(instance) as? Int
        }.getOrNull() ?: runCatching {
            val field = instance.javaClass.fields.firstOrNull { it.name == name }
            field?.get(instance) as? Int
        }.getOrNull()

    private fun readStringProperty(instance: Any, name: String): String? =
        runCatching {
            val method = instance.javaClass.methods.firstOrNull { it.name == name }
            method?.invoke(instance) as? String
        }.getOrNull() ?: runCatching {
            val field = instance.javaClass.fields.firstOrNull { it.name == name }
            field?.get(instance) as? String
        }.getOrNull()

    private fun dismiss(editor: Editor, status: InlineEditSession.Status) {
        val s = sessions.remove(editor) ?: return
        s.status = status
        try { s.highlighter?.dispose() } catch (_: Throwable) {}
        try { s.inlay?.dispose() } catch (_: Throwable) {}
    }

    private fun cleanup(editor: Editor) = dismiss(editor, InlineEditSession.Status.ACCEPTED)

    private fun emit(turnId: String, type: String, payload: Map<String, Any?>) {
        try { EventBus.getInstance(project).emit(turnId, turnId, type, payload) } catch (_: Throwable) {}
    }

    private fun languageHint(path: String): String {
        val ext = path.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "kt", "kts" -> "kotlin"
            "java" -> "java"
            "ts", "tsx" -> "typescript"
            "js", "jsx" -> "javascript"
            "py" -> "python"
            "go" -> "go"
            "rs" -> "rust"
            else -> ext.ifEmpty { "text" }
        }
    }

    /**
     * Strip surrounding ```lang … ``` fences if the model insists on them.
     * Tolerates leading/trailing whitespace.
     */
    private fun stripCodeFences(s: String): String {
        val trimmed = s.trim()
        val fenceRegex = Regex("^```[a-zA-Z0-9_+-]*\\s*\\n([\\s\\S]*?)\\n```\\s*\$")
        return fenceRegex.find(trimmed)?.groupValues?.get(1) ?: trimmed
    }

    companion object {
        fun getInstance(project: Project): InlineEditController = project.service()
    }
}
