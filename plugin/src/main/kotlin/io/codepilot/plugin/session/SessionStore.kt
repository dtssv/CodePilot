package io.codepilot.plugin.session

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.codepilot.plugin.settings.CodePilotSettings
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.util.UUID

/**
 * Local-only session store. Each session lives under
 * `<sessionRoot>/<workspaceHash>/<sessionId>/` and uses NDJSON files for incremental writes.
 *
 * Layout:
 *  - `meta.json`        — session metadata
 *  - `messages.ndjson`  — user / assistant / tool messages, append-only
 *  - `events.ndjson`    — full SSE events, append-only (for replay & debugging)
 *  - `plan.json`        — last merged Plan
 *  - `ledger.json`      — last TaskLedger snapshot
 *  - `checkpoint.json`  — last "next-step" hint, used by /conversation/resume
 */
@Service(Service.Level.APP)
class SessionStore {

    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val crypto: SessionCryptoService = SessionCryptoService.getInstance()

    fun newSession(workspaceHash: String, mode: String, modelId: String?): SessionHandle {
        val id = UUID.randomUUID().toString()
        val root = sessionDir(workspaceHash, id).also { Files.createDirectories(it) }
        val meta =
            SessionMeta(
                id = id,
                workspaceHash = workspaceHash,
                createdAt = Instant.now().toString(),
                updatedAt = Instant.now().toString(),
                lastMessageAt = null,
                mode = mode,
                modelId = modelId,
                title = null,
            )
        writeJson(root.resolve("meta.json"), meta)
        return SessionHandle(root, meta)
    }

    fun appendMessage(handle: SessionHandle, role: String, content: String) {
        val payload =
            mapOf(
                "role" to role,
                "content" to content,
                "ts" to Instant.now().toString(),
            )
        appendNdjson(handle.dir.resolve("messages.ndjson"), payload)
    }

    fun appendEvent(handle: SessionHandle, event: String, data: Any) {
        appendNdjson(
            handle.dir.resolve("events.ndjson"),
            mapOf("event" to event, "data" to data, "ts" to Instant.now().toString()),
        )
    }

    fun savePlan(handle: SessionHandle, plan: Any?) {
        if (plan != null) writeJson(handle.dir.resolve("plan.json"), plan)
    }

    fun saveLedger(handle: SessionHandle, ledger: Any?) {
        if (ledger != null) writeJson(handle.dir.resolve("ledger.json"), ledger)
    }

    fun saveCheckpoint(handle: SessionHandle, checkpoint: Any) {
        writeJson(handle.dir.resolve("checkpoint.json"), checkpoint)
    }

    /** Load the last saved checkpoint for session recovery. */
    fun loadCheckpoint(handle: SessionHandle): Map<String, Any>? {
        val file = handle.dir.resolve("checkpoint.json")
        if (!Files.exists(file)) return null
        return runCatching {
            @Suppress("UNCHECKED_CAST")
            mapper.readValue(Files.readAllBytes(file), Map::class.java) as Map<String, Any>
        }.getOrNull()
    }

    /** Load the last saved plan. */
    fun loadPlan(handle: SessionHandle): Map<String, Any>? {
        val file = handle.dir.resolve("plan.json")
        if (!Files.exists(file)) return null
        return runCatching {
            @Suppress("UNCHECKED_CAST")
            mapper.readValue(Files.readAllBytes(file), Map::class.java) as Map<String, Any>
        }.getOrNull()
    }

    /** Load the last saved task ledger. */
    fun loadLedger(handle: SessionHandle): Map<String, Any>? {
        val file = handle.dir.resolve("ledger.json")
        if (!Files.exists(file)) return null
        return runCatching {
            @Suppress("UNCHECKED_CAST")
            mapper.readValue(Files.readAllBytes(file), Map::class.java) as Map<String, Any>
        }.getOrNull()
    }

    /** Append an Agent step record (for replay and checkpoint recovery). */
    fun appendStep(handle: SessionHandle, step: Map<String, Any?>) {
        appendNdjson(handle.dir.resolve("steps.ndjson"), step)
    }

    /** Read all completed steps (for resume: determines which tool calls to skip). */
    fun readSteps(handle: SessionHandle): List<Map<String, Any>> {
        val file = handle.dir.resolve("steps.ndjson")
        if (!Files.exists(file)) return emptyList()
        return Files.readAllLines(file).filter { it.isNotBlank() }.mapNotNull { line ->
            @Suppress("UNCHECKED_CAST")
            runCatching { mapper.readValue(line, Map::class.java) as Map<String, Any> }.getOrNull()
        }
    }

    /** Get completed tool call IDs (for idempotency check on resume). */
    fun completedToolCallIds(handle: SessionHandle): Set<String> {
        return readSteps(handle)
            .mapNotNull { it["toolCallId"] as? String }
            .toSet()
    }

    /** Save a session digest (context compression result). */
    fun saveDigest(handle: SessionHandle, digest: Any) {
        writeJson(handle.dir.resolve("digest.json"), digest)
    }

    /** Load the last session digest. */
    fun loadDigest(handle: SessionHandle): Map<String, Any>? {
        val file = handle.dir.resolve("digest.json")
        if (!Files.exists(file)) return null
        return runCatching {
            @Suppress("UNCHECKED_CAST")
            mapper.readValue(Files.readAllBytes(file), Map::class.java) as Map<String, Any>
        }.getOrNull()
    }

    /** Check if a session has a recoverable checkpoint. */
    fun hasCheckpoint(handle: SessionHandle): Boolean {
        return Files.exists(handle.dir.resolve("checkpoint.json"))
    }

    fun list(workspaceHash: String): List<SessionMeta> {
        val parent = settingsRoot().resolve(workspaceHash)
        if (!Files.isDirectory(parent)) return emptyList()
        return Files.list(parent).use { stream ->
            stream
                .filter { Files.isDirectory(it) }
                .map { readMeta(it) }
                .filter { it != null }
                .map { it!! }
                .toList()
        }
    }

    fun resolve(workspaceHash: String, sessionId: String): SessionHandle? {
        val dir = sessionDir(workspaceHash, sessionId)
        val meta = readMeta(dir) ?: return null
        return SessionHandle(dir, meta)
    }

    /** Update session metadata in place and persist. */
    fun updateMeta(handle: SessionHandle, block: (SessionMeta) -> Unit) {
        block(handle.meta)
        handle.meta.updatedAt = Instant.now().toString()
        writeJson(handle.dir.resolve("meta.json"), handle.meta)
    }

    /** Touch the lastMessageAt timestamp. */
    fun touchLastMessage(handle: SessionHandle) {
        handle.meta.lastMessageAt = Instant.now().toString()
        handle.meta.updatedAt = Instant.now().toString()
        writeJson(handle.dir.resolve("meta.json"), handle.meta)
    }

    /** Read all messages from messages.ndjson for session recovery. */
    fun readMessages(handle: SessionHandle): List<Map<String, Any>> {
        val file = handle.dir.resolve("messages.ndjson")
        if (!Files.exists(file)) return emptyList()
        return Files.readAllLines(file).filter { it.isNotBlank() }.map { line ->
            mapper.readValue(line, Map::class.java) as Map<String, Any>
        }
    }

    /** Delete a session directory. */
    fun delete(workspaceHash: String, sessionId: String) {
        val dir = sessionDir(workspaceHash, sessionId)
        if (Files.exists(dir)) dir.toFile().deleteRecursively()
    }

    private fun sessionDir(workspaceHash: String, sessionId: String): Path =
        settingsRoot().resolve(workspaceHash).resolve(sessionId)

    private fun settingsRoot(): Path = CodePilotSettings.getInstance().sessionRootPath()

    private fun appendNdjson(file: Path, payload: Any) {
        Files.createDirectories(file.parent)
        val line = mapper.writeValueAsString(payload) + "\n"
        val bytes = if (crypto.isEncryptionEnabled()) {
            // For encrypted NDJSON, each line is individually encrypted and Base64-encoded
            (crypto.encryptText(line) + "\n").toByteArray(StandardCharsets.UTF_8)
        } else {
            line.toByteArray(StandardCharsets.UTF_8)
        }
        Files.write(file, bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND)
    }

    private fun writeJson(file: Path, payload: Any) {
        Files.createDirectories(file.parent)
        val content = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(payload)
        if (crypto.isEncryptionEnabled()) {
            Files.writeString(file, crypto.encryptText(content))
        } else {
            Files.writeString(file, content)
        }
    }

    private fun readMeta(dir: Path): SessionMeta? {
        val meta = dir.resolve("meta.json")
        if (!Files.exists(meta)) return null
        return runCatching { mapper.readValue(Files.readAllBytes(meta), SessionMeta::class.java) }.getOrNull()
    }

    data class SessionHandle(val dir: Path, var meta: SessionMeta)

    data class SessionMeta(
        val id: String,
        val workspaceHash: String,
        var createdAt: String,
        var updatedAt: String,
        var lastMessageAt: String?,
        val mode: String,
        val modelId: String?,
        var title: String?,
    )

    companion object {
        @JvmStatic fun getInstance(): SessionStore = service()
    }
}   }
}