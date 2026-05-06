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

    fun newSession(workspaceHash: String, mode: String, modelId: String?): SessionHandle {
        val id = UUID.randomUUID().toString()
        val root = sessionDir(workspaceHash, id).also { Files.createDirectories(it) }
        val meta =
            SessionMeta(
                id = id,
                workspaceHash = workspaceHash,
                createdAt = Instant.now().toString(),
                updatedAt = Instant.now().toString(),
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

    private fun sessionDir(workspaceHash: String, sessionId: String): Path =
        settingsRoot().resolve(workspaceHash).resolve(sessionId)

    private fun settingsRoot(): Path = CodePilotSettings.getInstance().sessionRootPath()

    private fun appendNdjson(file: Path, payload: Any) {
        Files.createDirectories(file.parent)
        Files.write(
            file,
            (mapper.writeValueAsString(payload) + "\n").toByteArray(StandardCharsets.UTF_8),
            StandardOpenOption.CREATE,
            StandardOpenOption.APPEND,
        )
    }

    private fun writeJson(file: Path, payload: Any) {
        Files.createDirectories(file.parent)
        Files.writeString(file, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(payload))
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
        val mode: String,
        val modelId: String?,
        var title: String?,
    )

    companion object {
        @JvmStatic fun getInstance(): SessionStore = service()
    }
}