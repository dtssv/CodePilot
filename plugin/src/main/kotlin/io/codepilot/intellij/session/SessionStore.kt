package io.codepilot.intellij.session

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Instant

/**
 * Local session persistence using NDJSON format.
 *
 * Directory structure:
 * ```
 * ~/.codepilot/sessions/<workspaceHash>/
 * ├── index.json          # Session metadata index
 * ├── <sessionId>/
 * │   ├── messages.ndjson # All messages (user/assistant/tool)
 * │   ├── steps.ndjson    # Agent steps with tool calls
 * │   ├── plans/          # Plan snapshots
 * │   ├── summaries/      # Digest summaries
 * │   └── meta.json       # Session metadata
 * ```
 */
class SessionStore(private val project: Project) {

    private val log = Logger.getInstance(SessionStore::class.java)
    private val mapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())

    private val baseDir: Path by lazy {
        val workspaceHash = (project.basePath ?: "default").hashCode().toString(16)
        Paths.get(System.getProperty("user.home"), ".codepilot", "sessions", workspaceHash)
            .also { Files.createDirectories(it) }
    }

    // ── Session CRUD ───────────────────────────────────────────────────

    fun list(): List<SessionMeta> {
        val indexFile = baseDir.resolve("index.json").toFile()
        if (!indexFile.exists()) return emptyList()
        return try {
            mapper.readValue(indexFile, mapper.typeFactory.constructCollectionType(
                ArrayList::class.java, SessionMeta::class.java
            ))
        } catch (e: Exception) {
            log.warn("Failed to read session index", e)
            emptyList()
        }
    }

    fun create(meta: SessionMeta): SessionMeta {
        val sessionDir = baseDir.resolve(meta.id)
        Files.createDirectories(sessionDir)
        Files.createDirectories(sessionDir.resolve("plans"))
        Files.createDirectories(sessionDir.resolve("summaries"))

        // Write meta
        mapper.writeValue(sessionDir.resolve("meta.json").toFile(), meta)

        // Update index
        val sessions = list().toMutableList()
        sessions.add(0, meta)
        writeIndex(sessions)

        return meta
    }

    fun get(sessionId: String): SessionMeta? {
        val metaFile = baseDir.resolve(sessionId).resolve("meta.json").toFile()
        if (!metaFile.exists()) return null
        return try {
            mapper.readValue(metaFile, SessionMeta::class.java)
        } catch (e: Exception) {
            null
        }
    }

    fun update(sessionId: String, updater: (SessionMeta) -> SessionMeta) {
        val meta = get(sessionId) ?: return
        val updated = updater(meta)
        val metaFile = baseDir.resolve(sessionId).resolve("meta.json").toFile()
        mapper.writeValue(metaFile, updated)

        // Update index
        val sessions = list().toMutableList()
        val idx = sessions.indexOfFirst { it.id == sessionId }
        if (idx >= 0) {
            sessions[idx] = updated
            writeIndex(sessions)
        }
    }

    // ── Message Append ─────────────────────────────────────────────────

    fun appendMessage(sessionId: String, message: SessionMessage) {
        val file = baseDir.resolve(sessionId).resolve("messages.ndjson").toFile()
        file.appendText(mapper.writeValueAsString(message) + "\n")
    }

    fun appendStep(sessionId: String, step: StepRecord) {
        val file = baseDir.resolve(sessionId).resolve("steps.ndjson").toFile()
        file.appendText(mapper.writeValueAsString(step) + "\n")
    }

    // ── Plan / Summary ─────────────────────────────────────────────────

    fun savePlan(sessionId: String, version: Int, plan: Any) {
        val file = baseDir.resolve(sessionId).resolve("plans").resolve("plan-$version.json").toFile()
        mapper.writeValue(file, plan)
    }

    fun loadLatestPlan(sessionId: String): Any? {
        val plansDir = baseDir.resolve(sessionId).resolve("plans").toFile()
        val files = plansDir.listFiles()?.filter { it.name.startsWith("plan-") }?.sortedByDescending { it.name }
            ?: return null
        if (files.isEmpty()) return null
        return try { mapper.readValue(files.first(), Any::class.java) } catch (_: Exception) { null }
    }

    fun saveSummary(sessionId: String, summary: String) {
        val file = baseDir.resolve(sessionId).resolve("summaries").resolve("latest.json").toFile()
        mapper.writeValue(file, mapOf("summary" to summary, "updatedAt" to Instant.now()))
    }

    fun loadLatestSummary(sessionId: String): String? {
        val file = baseDir.resolve(sessionId).resolve("summaries").resolve("latest.json").toFile()
        if (!file.exists()) return null
        return try {
            @Suppress("UNCHECKED_CAST")
            val map = mapper.readValue(file, Map::class.java) as Map<String, Any>
            map["summary"] as? String
        } catch (_: Exception) { null }
    }

    // ── Token Estimation ───────────────────────────────────────────────

    fun estimateTokens(sessionId: String): Long {
        val file = baseDir.resolve(sessionId).resolve("messages.ndjson").toFile()
        if (!file.exists()) return 0
        val totalChars = file.readLines().sumOf { it.length }
        return totalChars / 3L
    }

    // ── Internal ───────────────────────────────────────────────────────

    private fun writeIndex(sessions: List<SessionMeta>) {
        mapper.writeValue(baseDir.resolve("index.json").toFile(), sessions)
    }
}

/** Session metadata. */
data class SessionMeta(
    val id: String,
    val title: String?,
    val modelId: String,
    val mode: String,            // chat | agent
    val createdAt: Instant,
    val updatedAt: Instant,
    val messageCount: Int = 0,
    val projectId: String? = null
)

/** A single message in the session. */
data class SessionMessage(
    val role: String,            // user | assistant | tool
    val content: String,
    val timestamp: Instant,
    val toolCallId: String? = null,
    val toolName: String? = null
)

/** A step record for agent mode. */
data class StepRecord(
    val stepNumber: Int,
    val toolCallId: String?,
    val toolName: String?,
    val result: String?,
    val ok: Boolean?,
    val durationMs: Long?,
    val timestamp: Instant
)