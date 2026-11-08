package com.codepilot.idea

import javax.swing.JComponent

/** What the tool window and editor actions need from a chat panel. */
interface ChatHost {
    val component: JComponent

 /**
  * Hand an editor snippet (or whole file) to the chat as a reference, WITHOUT
  * sending — the user writes their own prompt around it (Cursor "Add to Chat").
  * When [newChat] is true, open a fresh session first ("Add to New Chat").
  */
    fun addEditorContext(filePath: String, language: String?, snippet: String, newChat: Boolean)

    fun dispose()
}
