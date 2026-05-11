package io.codepilot.plugin.keymap

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.keymap.KeymapManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.SystemInfoRt
import javax.swing.KeyStroke

/**
 * Registers CodePilot keyboard shortcuts matching Cursor conventions.
 *
 * Ctrl+K: inline-completion, Ctrl+L: open-chat,
 * Ctrl+I: toggle-agent, Ctrl+Shift+P: command-palette,
 * Escape: dismiss-completion, Ctrl+Enter: send-message
 */
class CodePilotKeymap : ProjectActivity {
    override suspend fun execute(project: Project) {
        registerActions()
        registerShortcuts()
    }

    private fun registerActions() {
        val am = ActionManager.getInstance()
        registerIfAbsent(am, "CodePilot.InlineCompletion", InlineCompletionAction())
        registerIfAbsent(am, "CodePilot.OpenChat", OpenChatAction())
        registerIfAbsent(am, "CodePilot.ToggleAgent", ToggleAgentAction())
        registerIfAbsent(am, "CodePilot.NewChat", NewChatAction())
        registerIfAbsent(am, "CodePilot.AcceptCompletion", AcceptCompletionAction())
        registerIfAbsent(am, "CodePilot.DismissCompletion", DismissCompletionAction())
        registerIfAbsent(am, "CodePilot.SendMessage", SendMessageAction())
        registerIfAbsent(am, "CodePilot.CommandPalette", CommandPaletteAction())
    }

    private fun registerShortcuts() {
        val keymap = KeymapManager.getInstance().activeKeymap
        addShortcut(keymap, "CodePilot.InlineCompletion", "control K", "meta K")
        addShortcut(keymap, "CodePilot.OpenChat", "control L", "meta L")
        addShortcut(keymap, "CodePilot.ToggleAgent", "control I", "meta I")
        addShortcut(keymap, "CodePilot.NewChat", "control shift L", "meta shift L")
        addShortcut(keymap, "CodePilot.AcceptCompletion", "control shift K", "meta shift K")
        addShortcut(keymap, "CodePilot.DismissCompletion", "ESCAPE")
        addShortcut(keymap, "CodePilot.SendMessage", "control ENTER", "meta ENTER")
        addShortcut(keymap, "CodePilot.CommandPalette", "control shift P", "meta shift P")
    }

    private fun registerIfAbsent(am: ActionManager, id: String, action: AnAction) {
        try { if (am.getAction(id) == null) am.registerAction(id, action) } catch (_: Exception) {}
    }

    private fun addShortcut(keymap: com.intellij.openapi.keymap.Keymap, actionId: String, vararg specs: String) {
        try {
            for (spec in specs) {
                val isMac = SystemInfoRt.isMac
                if ((isMac && spec.startsWith("meta")) || (!isMac && spec.startsWith("control"))) {
                    val stroke = parseKeystroke(spec) ?: continue
                    val shortcut = com.intellij.openapi.actionSystem.KeyboardShortcut(stroke, null)
                    keymap.addShortcut(actionId, shortcut)
                    break
                }
            }
        } catch (_: Exception) {}
    }

    private fun parseKeystroke(spec: String): KeyStroke? {
        return try {
            val parts = spec.split(" ")
            val modifiers = parts.dropLast(1).fold(0) { acc, mod ->
                acc or when (mod.lowercase()) {
                    "control" -> java.awt.event.InputEvent.CTRL_DOWN_MASK
                    "meta" -> java.awt.event.InputEvent.META_DOWN_MASK
                    "shift" -> java.awt.event.InputEvent.SHIFT_DOWN_MASK
                    "alt" -> java.awt.event.InputEvent.ALT_DOWN_MASK
                    else -> 0
                }
            }
            val key = parts.last()
            val keyCode = when (key.uppercase()) {
                "ENTER" -> java.awt.event.KeyEvent.VK_ENTER
                "ESCAPE" -> java.awt.event.KeyEvent.VK_ESCAPE
                "TAB" -> java.awt.event.KeyEvent.VK_TAB
                "SPACE" -> java.awt.event.KeyEvent.VK_SPACE
                else -> key.firstOrNull()?.code ?: return null
            }
            KeyStroke.getKeyStroke(keyCode, modifiers)
        } catch (_: Exception) { null }
    }
}