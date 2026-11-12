package com.codepilot.idea

import com.intellij.codeInsight.inline.completion.DebouncedInlineCompletionProvider
import com.intellij.codeInsight.inline.completion.InlineCompletionEvent
import com.intellij.codeInsight.inline.completion.InlineCompletionProviderID
import com.intellij.codeInsight.inline.completion.InlineCompletionRequest
import com.intellij.codeInsight.inline.completion.elements.InlineCompletionGrayTextElement
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSingleSuggestion
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSuggestion
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.ui.popup.util.PopupUtil
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/**
 * Inline (Tab) completion for IntelliJ, mirroring the VSCode provider.
 *
 * Design: docs/design/G-inline-completion.md. Thin by design — all model /
 * prompt / block-truncation logic lives in core/protocol behind the
 * `completion/inline` RPC. This provider only:
 *   - gates on the opt-in setting + a non-empty prefix,
 *   - reads capped prefix/suffix around the cursor (in a ReadAction),
 *   - calls the shared [CodepilotClient] off the EDT (its request is blocking),
 *   - renders the result as a single gray-text element, or nothing.
 *
 * Debounce + cancellation come free from [DebouncedInlineCompletionProvider]
 * (the platform cancels the previous request when a new one starts). The RPC is
 * fast-fail server-side, so a stale completion resolves cheaply.
 *
 * Registered only on platforms where this (experimental) API is present — see
 * the `com.intellij.inline.completion.provider` EP in plugin.xml, gated to
 * since-build 241.
 */
class CodepilotInlineCompletionProvider : DebouncedInlineCompletionProvider() {

    private val log = logger<CodepilotInlineCompletionProvider>()

    /** Small client-side LRU. The hit that matters is backspace/retype: it
     * resolves here with zero RPC round-trip. Empty results are cached too.
     * Access-order + removeEldestEntry gives bounded LRU; wrapped synchronized
     * because completions can arrive off several dispatcher threads. */
    private val cache: MutableMap<String, String> =
        java.util.Collections.synchronizedMap(
            object : LinkedHashMap<String, String>(16, 0.75f, true) {
                override fun removeEldestEntry(eldest: Map.Entry<String, String>): Boolean = size > CACHE_MAX
            },
        )

    override val id: InlineCompletionProviderID = InlineCompletionProviderID("CodePilot")

    override suspend fun getDebounceDelay(request: InlineCompletionRequest): Duration =
        settingsState().completionDebounceMs.coerceAtLeast(0).milliseconds

    override fun isEnabled(event: InlineCompletionEvent): Boolean = settingsState().completionEnabled

    override suspend fun getSuggestionDebounced(request: InlineCompletionRequest): InlineCompletionSuggestion {
        val s = settingsState()
        if (!s.completionEnabled) return InlineCompletionSuggestion.Empty

        val document = request.document
        val offset = request.endOffset
        val basePath = request.editor.project?.basePath

        // Read the document on a read action; cap the context like the VSCode side.
        val ctx = ReadAction.compute<CompletionContext?, RuntimeException> {
            val textLen = document.textLength
            if (offset <= 0 || offset > textLen) return@compute null
            val full = document.charsSequence
            val rawPrefix = full.subSequence(0, offset).toString()
            if (rawPrefix.isBlank()) return@compute null
            val rawSuffix = full.subSequence(offset, textLen).toString()
            val prefix = if (rawPrefix.length > PREFIX_CAP) rawPrefix.takeLast(PREFIX_CAP) else rawPrefix
            val suffix = if (rawSuffix.length > SUFFIX_CAP) rawSuffix.take(SUFFIX_CAP) else rawSuffix
            // Workspace-relative path (with directories), so the server and the
            // cache key see the same stable identifier the other editor sends —
            // fall back to the bare file name outside a project.
            val vf = request.file?.virtualFile
            val path = relativePath(vf?.path, basePath) ?: vf?.name ?: "untitled"
            CompletionContext(prefix, suffix, path)
        } ?: return InlineCompletionSuggestion.Empty

        // Client cache: a hit returns instantly with NO RPC round-trip. Empty
        // results are cached too, so backspace/retype over a spot that produced
        // nothing also stays free.
        val key = cacheKey(ctx.path, ctx.prefix, ctx.suffix)
        cache.get(key)?.let { cached ->
            return if (cached.isEmpty()) InlineCompletionSuggestion.Empty else suggestionOf(cached)
        }

        val client = CodepilotService.getInstance().client() ?: return InlineCompletionSuggestion.Empty

        // Own the requestId so a superseded request (the platform cancels the
        // coroutine when a newer keystroke arrives) can tell the server to abort
        // the upstream model call instead of letting it keep burning tokens.
        val requestId = "idea-${completionSeq.incrementAndGet()}"

        // The client's request is blocking; run it off the EDT / coroutine
        // dispatcher. On cancellation, fire completion/cancel to the server.
        val completion = try {
            withContext(Dispatchers.IO) {
                client.inlineComplete(
                    prefix = ctx.prefix,
                    suffix = ctx.suffix,
                    path = ctx.path,
                    maxTokens = s.completionMaxTokens.coerceAtLeast(1),
                    requestId = requestId,
                    onDisabled = { reason ->
                        if (reason == "no-small-model") warnNoSmallModelOnce()
                    },
                )
            }
        } catch (c: kotlinx.coroutines.CancellationException) {
            client.cancelCompletion(requestId)
            throw c
        }

        // Cache the outcome (including empty) under the context key.
        cache.put(key, completion ?: "")

        if (completion.isNullOrEmpty()) return InlineCompletionSuggestion.Empty
        return suggestionOf(completion)
    }

    private fun suggestionOf(text: String): InlineCompletionSuggestion =
        InlineCompletionSingleSuggestion.build {
            emit(InlineCompletionGrayTextElement(text))
        }

    private fun settingsState(): CodepilotSettings.State = CodepilotSettings.getInstance().state

    private fun warnNoSmallModelOnce() {
        if (warned) return
        warned = true
        ApplicationManager.getApplication().invokeLater {
            PopupUtil.showBalloonForActiveComponent(
                "CodePilot completion needs a lightweight model distinct from your main chat model. " +
                    "Configure a small/completion model (e.g. a local Ollama qwen2.5-coder, or a free Groq / Gemini Flash model).",
                com.intellij.openapi.ui.MessageType.INFO,
            )
        }
    }

    private data class CompletionContext(val prefix: String, val suffix: String, val path: String)

    companion object {
        private const val PREFIX_CAP = 4000
        private const val SUFFIX_CAP = 2000

        /** Small client LRU — the hit that matters is backspace/retype. */
        private const val CACHE_MAX = 64

        /** Monotonic source for per-request completion ids used to cancel a
         * superseded upstream call. */
        private val completionSeq = java.util.concurrent.atomic.AtomicLong(0)

        @Volatile
        private var warned = false

        private fun cacheKey(path: String, prefix: String, suffix: String): String =
            CompletionKeys.cacheKey(path, prefix, suffix)

        private fun relativePath(absolute: String?, basePath: String?): String? =
            CompletionKeys.relativePath(absolute, basePath)
    }
}

/**
 * Pure helpers for the inline-completion client cache: a stable, bounded cache
 * key and workspace-relative path resolution. Kept separate (and `internal`)
 * from the IntelliJ-coupled provider so they are unit-testable without a
 * platform fixture.
 */
internal object CompletionKeys {
    /** Tail of prefix + head of suffix is what determines the completion;
     * hashing keeps the key bounded and stable under the context cap. */
    fun cacheKey(path: String, prefix: String, suffix: String): String =
        "$path\u0000${hash(prefix.takeLast(512))}\u0000${hash(suffix.take(256))}"

    /** FNV-1a over 32 bits, rendered base36. Stable within a process. */
    fun hash(s: String): String {
        var h = -0x7ee3623b // 2166136261 as Int (FNV-1a offset basis)
        for (c in s) {
            h = h xor c.code
            h *= 16777619
        }
        return (h.toLong() and 0xffffffffL).toString(36)
    }

    /** Workspace-relative path with directories, matching the VSCode side.
     * Null when the file is outside the project (caller falls back to name). */
    fun relativePath(absolute: String?, basePath: String?): String? {
        if (absolute == null || basePath == null) return null
        val prefix = if (basePath.endsWith("/")) basePath else "$basePath/"
        return if (absolute.startsWith(prefix)) absolute.removePrefix(prefix) else null
    }
}
