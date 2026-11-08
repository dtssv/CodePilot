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

    override val id: InlineCompletionProviderID = InlineCompletionProviderID("CodePilot")

    override suspend fun getDebounceDelay(request: InlineCompletionRequest): Duration =
        settingsState().completionDebounceMs.coerceAtLeast(0).milliseconds

    override fun isEnabled(event: InlineCompletionEvent): Boolean = settingsState().completionEnabled

    override suspend fun getSuggestionDebounced(request: InlineCompletionRequest): InlineCompletionSuggestion {
        val s = settingsState()
        if (!s.completionEnabled) return InlineCompletionSuggestion.Empty

        val document = request.document
        val offset = request.endOffset

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
            val path = request.file?.virtualFile?.name ?: "untitled"
            CompletionContext(prefix, suffix, path)
        } ?: return InlineCompletionSuggestion.Empty

        val client = CodepilotService.getInstance().client() ?: return InlineCompletionSuggestion.Empty

        // The client's request is blocking; run it off the EDT / coroutine dispatcher.
        val completion = withContext(Dispatchers.IO) {
            client.inlineComplete(
                prefix = ctx.prefix,
                suffix = ctx.suffix,
                path = ctx.path,
                maxTokens = s.completionMaxTokens.coerceAtLeast(1),
                onDisabled = { reason ->
                    if (reason == "no-small-model") warnNoSmallModelOnce()
                },
            )
        }

        if (completion.isNullOrEmpty()) return InlineCompletionSuggestion.Empty
        return InlineCompletionSingleSuggestion.build {
            emit(InlineCompletionGrayTextElement(completion))
        }
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

        @Volatile
        private var warned = false
    }
}
