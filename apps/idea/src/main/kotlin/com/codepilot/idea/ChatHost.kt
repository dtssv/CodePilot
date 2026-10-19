package com.codepilot.idea

import javax.swing.JComponent

/** What the tool window and editor actions need from a chat panel. */
interface ChatHost {
    val component: JComponent

 /** Hand an editor snippet (or whole file) to the chat. */
    fun sendEditorContext(filePath: String, language: String?, snippet: String)

    fun dispose()
}
