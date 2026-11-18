package com.codepilot.idea

import javax.swing.JComponent

/** What the tool window and editor actions need from a chat panel. */
interface ChatHost {
    val component: JComponent

 /**
  * Hand an editor snippet (or whole file) to the chat as a reference, WITHOUT
 * sending — the user writes their own prompt around it.
 * When [newChat] is true, open a fresh session first.
  */
    fun addEditorContext(filePath: String, language: String?, snippet: String, newChat: Boolean)

    /** Expand/focus this panel and open the in-webview Settings sheet (Desktop-parity). */
    fun openSettings()

    fun dispose()
}
