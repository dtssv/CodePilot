package com.codepilot.idea

import javax.swing.JComponent

/** What the tool window and editor actions need from a chat panel. */
interface ChatHost {
    val component: JComponent

 /**
  * Hand a file (optionally a line range) to the chat as a reference, WITHOUT
  * sending — the user writes their own prompt around it.
  * When [newChat] is true, open a fresh session first.
  */
    fun addReference(path: String, startLine: Int?, endLine: Int?, newChat: Boolean)

    /** Send [question] together with the same reference ("ask about this code"). */
    fun askAboutCode(path: String, startLine: Int?, endLine: Int?, question: String)

    /**
     * Open Settings — an editor tab in the JCEF panel, the configurable in Swing.
     * [section] jumps to one page of the settings UI; the Swing fallback ignores it.
     */
    fun openSettings(section: String? = null)

    fun dispose()
}
