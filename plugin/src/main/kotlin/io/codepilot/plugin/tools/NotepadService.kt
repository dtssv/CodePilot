package io.codepilot.plugin.tools

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * ★ NotepadService: Context scratchpad for Agent mode.
 *
 * Provides named notepads where the LLM can store intermediate context
 * (e.g., architecture notes, API contracts, decisions) that persists
 * across tool calls within a session. This enables the Agent to
 * maintain working memory without flooding the conversation.
 *
 * Notepads are:
 * - Scoped per session (session ID → notepad entries)
 * - Automatically cleaned up when sessions close
 * - Accessible via the `notepad.read` / `notepad.write` tool
 */
@Service(Service.Level.PROJECT)
class NotepadService(
    private val project: Project,
) : Disposable {
    private val log = Logger.getInstance(NotepadService::class.java)
    private val sessionNotepads = ConcurrentHashMap<String, MutableMap<String, NotepadEntry>>()

    data class NotepadEntry(
        val id: String,
        val name: String,
        val content: String,
        val createdAt: String,
        val updatedAt: String,
    )

    /**
     * Write or update a notepad entry.
     */
    fun write(
        sessionId: String,
        name: String,
        content: String,
    ): NotepadEntry {
        val notepads = sessionNotepads.computeIfAbsent(sessionId) { ConcurrentHashMap() }
        val existing = notepads[name]
        val now = Instant.now().toString()
        val entry =
            if (existing != null) {
                existing.copy(content = content, updatedAt = now)
            } else {
                NotepadEntry(
                    id = UUID.randomUUID().toString().take(8),
                    name = name,
                    content = content,
                    createdAt = now,
                    updatedAt = now,
                )
            }
        notepads[name] = entry
        log.info("Notepad write: session=$sessionId name=$name chars=${content.length}")
        return entry
    }

    /**
     * Read a notepad entry by name.
     */
    fun read(
        sessionId: String,
        name: String,
    ): NotepadEntry? = sessionNotepads[sessionId]?.get(name)

    /**
     * List all notepad entries for a session.
     */
    fun list(sessionId: String): List<NotepadEntry> = sessionNotepads[sessionId]?.values?.toList() ?: emptyList()

    /**
     * Delete a notepad entry.
     */
    fun delete(
        sessionId: String,
        name: String,
    ): Boolean = sessionNotepads[sessionId]?.remove(name) != null

    /**
     * Clear all notepads for a session (called when session closes).
     */
    fun clearSession(sessionId: String) {
        sessionNotepads.remove(sessionId)
        log.info("Notepad session cleared: $sessionId")
    }

    /**
     * Get the combined content of all notepads for a session (for prompt injection).
     */
    fun getCombinedContext(
        sessionId: String,
        maxChars: Int = 4000,
    ): String {
        val entries = list(sessionId)
        if (entries.isEmpty()) return ""
        val sb = StringBuilder("[NOTEPAD_CONTEXT_BEGIN]\n")
        for (entry in entries) {
            val header = "## ${entry.name} (updated ${entry.updatedAt})\n"
            if (sb.length + header.length + entry.content.length > maxChars) break
            sb.append(header).append(entry.content).append("\n\n")
        }
        sb.append("[NOTEPAD_CONTEXT_END]")
        return sb.toString()
    }

    override fun dispose() {
        sessionNotepads.clear()
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): NotepadService = project.service()
    }
}
