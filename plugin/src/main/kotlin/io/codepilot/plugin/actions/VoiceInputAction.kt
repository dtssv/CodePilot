package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import io.codepilot.plugin.input.VoiceInputService

/**
 * ★ Integration: Voice Input Action — Triggers speech-to-text for chat input.
 *
 * Bound to a keymap shortcut (e.g., Ctrl+Shift+V) and also accessible
 * from the Command Palette. When activated:
 * 1. Starts microphone recording with VAD
 * 2. Shows recording indicator in status bar
 * 3. On completion, inserts transcribed text into the chat input field
 *
 * This action wires VoiceInputService into the IDE's action system,
 * making it accessible from keymaps, menus, and the command palette.
 */
class VoiceInputAction : AnAction("Voice Input", "Start voice input for chat (speech-to-text)", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return

        if (!VoiceInputService.isAvailable()) {
            com.intellij.openapi.ui.Messages.showInfoMessage(
                project,
                "Microphone not available. Please check your audio input device.",
                "Voice Input",
            )
            return
        }

        val state = VoiceInputService.getState(project)
        if (state.isRecording) {
            // Stop recording
            VoiceInputService.stopRecording(project)
        } else {
            // Start recording — result is inserted into chat input
            VoiceInputService.startRecording(project).thenAccept { transcript ->
                if (transcript.isNotBlank()) {
                    // Post the transcript to the CefChatPanel's input field
                    // via the PluginBridge's postMessage mechanism
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                        postTranscriptToChat(project, transcript)
                    }
                }
            }
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && VoiceInputService.isAvailable()

        // Update icon/text based on recording state
        if (project != null) {
            val state = VoiceInputService.getState(project)
            if (state.isRecording) {
                e.presentation.text = "Stop Voice Input"
                e.presentation.description = "Stop recording and insert transcript"
            } else {
                e.presentation.text = "Voice Input"
                e.presentation.description = "Start voice input for chat (speech-to-text)"
            }
        }
    }

    /**
     * Post the voice transcript into the chat input field.
     * Uses the CefChatPanel's JavaScript bridge to set the input text.
     */
    private fun postTranscriptToChat(project: Project, transcript: String) {
        try {
            val panel = io.codepilot.plugin.toolwindow.CefChatPanelRegistry.getCefPanel(project)
            if (panel != null) {
                val jsonTranscript = com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(transcript)
                panel.dispatchToWeb("set_input", mapOf("text" to transcript))
            }
        } catch (_: Exception) {
            // CefChatPanel not available — transcript is lost
        }
    }
}