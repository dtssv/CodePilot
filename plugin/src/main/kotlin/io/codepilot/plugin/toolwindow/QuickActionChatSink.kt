package io.codepilot.plugin.toolwindow

/**
 * Chat surface that IDE quick actions ([ActionBase], Add to Chat, PSI actions) can target.
 *
 * Implemented by [CefChatPanel] (WebUI) and [CodePilotChatPanel] (Swing fallback).
 */
interface QuickActionChatSink {
    fun storeContext(
        id: String,
        fullCode: String,
    )

    fun submitQuickUserMessage(
        textWithInlineContextMarkers: String,
        contextRefs: List<Map<String, Any?>>,
        mode: String = "agent",
    )

    /** WebUI chips; Swing may log a short line in the transcript. */
    fun dispatchContextAdded(meta: Map<String, Any?>) {}

    /** "Add to new chat" — start a blank session before attaching context. */
    fun prepareFreshChatSession() {}

    /** Switch WebUI to the chat tab (no-op on Swing fallback). */
    fun focusChatTab() {}
}
