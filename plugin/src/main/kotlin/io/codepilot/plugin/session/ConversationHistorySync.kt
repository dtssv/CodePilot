package io.codepilot.plugin.session

import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Conversation History Sync — Cross-device conversation synchronization.
 *
 * Uploads and downloads conversation history to/from the backend,
 * enabling users to continue conversations across different devices.
 *
 * Design:
 * - Push: Upload local session changes to backend on session close/periodic sync
 * - Pull: Download remote sessions on startup or on demand
 * - Conflict resolution: Last-write-wins based on updatedAt timestamp
 * - Privacy: Respects Privacy Mode (strict mode sessions are never synced)
 * - Incremental: Only syncs sessions modified since last sync timestamp
 *
 * Backend endpoints:
 * - POST /v1/sessions/sync — Upload local changes, receive remote changes
 * - GET /v1/sessions — List all remote sessions
 * - GET /v1/sessions/{id} — Get specific session with messages
 */
object ConversationHistorySync {

    private val mapper = ObjectMapper()

    data class SyncRequest(
        val deviceId: String,
        val lastSyncTs: Long,
        val sessions: List<SessionSnapshot>,
    )

    data class SyncResponse(
        val serverTs: Long,
        val sessions: List<SessionSnapshot>,
        val deletedSessionIds: List<String>,
    )

    data class SessionSnapshot(
        val id: String,
        val title: String?,
        val mode: String,
        val modelId: String?,
        val workspaceHash: String?,
        val updatedAt: Long,
        val messageCount: Int,
        val messagesBase64: String?, // GZIP + Base64 encoded messages.ndjson content, null if not modified
        val privacyMode: String?,
    )

    data class SyncStatus(
        val lastSyncTs: Long,
        val pendingUploads: Int,
        val lastSyncResult: String?, // "success" | "error:..."
    )

    // Per-project sync state
    private val syncState = ConcurrentHashMap<String, SyncStatus>()

    /**
     * Get the device ID for this installation.
     * Persisted in settings, generated on first use.
     */
    fun getDeviceId(): String {
        val settings = CodePilotSettings.getInstance()
        if (settings.state.deviceId.isBlank()) {
            settings.state.deviceId = "device_${System.currentTimeMillis()}_${(0..9999).random()}"
        }
        return settings.state.deviceId
    }

    /**
     * Perform a bidirectional sync: upload local changes, download remote changes.
     * Called periodically or on explicit user trigger.
     *
     * Returns the sync response with remote sessions to merge.
     */
    fun sync(project: Project): SyncResponse? {
        val basePath = project.basePath ?: return null
        val state = syncState.getOrPut(basePath) { SyncStatus(0L, 0, null) }

        // Collect locally modified sessions since last sync
        val sessionsRoot = Path.of(basePath, ".codepilot", "sessions")
        if (!Files.exists(sessionsRoot)) return null

        val localSnapshots = mutableListOf<SessionSnapshot>()
        val sessionDirs = Files.list(sessionsRoot).use { dirs ->
            dirs.filter { Files.isDirectory(it) }.toList()
        }

        for (sessionDir in sessionDirs) {
            val metaFile = sessionDir.resolve("meta.json")
            if (!Files.exists(metaFile)) continue

            try {
                val meta = mapper.readTree(Files.readString(metaFile))
                val privacyMode = meta.path("privacyMode").asText(null)
                // Skip strict privacy sessions
                if (privacyMode == "strict") continue

                val updatedAt = meta.path("updatedAt").asLong(0L)
                if (updatedAt <= state.lastSyncTs && state.lastSyncTs > 0) continue // Not modified

                val messagesFile = sessionDir.resolve("messages.ndjson")
                val messageCount = if (Files.exists(messagesFile)) {
                    Files.readAllLines(messagesFile).size
                } else 0

                val messagesBase64 = if (updatedAt > state.lastSyncTs && Files.exists(messagesFile)) {
                    val bytes = Files.readAllBytes(messagesFile)
                    java.util.Base64.getEncoder().encodeToString(
                        gzipCompress(bytes)
                    )
                } else null // Not modified, don't re-upload messages

                localSnapshots.add(SessionSnapshot(
                    id = meta.path("id").asText(sessionDir.fileName.toString()),
                    title = meta.path("title").asText(null),
                    mode = meta.path("mode").asText("chat"),
                    modelId = meta.path("modelId").asText(null),
                    workspaceHash = meta.path("workspaceHash").asText(null),
                    updatedAt = updatedAt,
                    messageCount = messageCount,
                    messagesBase64 = messagesBase64,
                    privacyMode = privacyMode,
                ))
            } catch (_: Exception) { continue }
        }

        // Build sync request
        val request = SyncRequest(
            deviceId = getDeviceId(),
            lastSyncTs = state.lastSyncTs,
            sessions = localSnapshots,
        )

        // Send to backend
        return try {
            val http = HttpClientService.getInstance()
            val payload = mapper.writeValueAsString(request)
            val httpRequest = http.postJson("/v1/sessions/sync", mapper.readValue(payload, Map::class.java))
            val response = http.client().newCall(httpRequest).execute()

            response.use { resp ->
                if (!resp.isSuccessful) {
                    syncState[basePath] = state.copy(
                        lastSyncResult = "error: ${resp.code}",
                        pendingUploads = localSnapshots.size,
                    )
                    return null
                }

                val body = resp.body?.string() ?: return null
                val syncResponse = mapper.readValue(body, SyncResponse::class.java)

                // Merge remote sessions into local
                mergeRemoteSessions(project, syncResponse.sessions)

                // Delete remotely-deleted sessions
                for (deletedId in syncResponse.deletedSessionIds) {
                    deleteLocalSession(sessionsRoot, deletedId)
                }

                // Update sync state
                syncState[basePath] = SyncStatus(
                    lastSyncTs = syncResponse.serverTs,
                    pendingUploads = 0,
                    lastSyncResult = "success",
                )

                syncResponse
            }
        } catch (e: Exception) {
            syncState[basePath] = state.copy(
                lastSyncResult = "error: ${e.message}",
                pendingUploads = localSnapshots.size,
            )
            null
        }
    }

    /**
     * Get the current sync status for a project.
     */
    fun getSyncStatus(project: Project): SyncStatus {
        val basePath = project.basePath ?: return SyncStatus(0L, 0, null)
        return syncState.getOrPut(basePath) { SyncStatus(0L, 0, null) }
    }

    // ─── Internal ──────────────────────────────────────────────────────

    private fun mergeRemoteSessions(project: Project, remoteSessions: List<SessionSnapshot>) {
        val sessionsRoot = Path.of(project.basePath!!, ".codepilot", "sessions")
        for (remote in remoteSessions) {
            val sessionDir = sessionsRoot.resolve(remote.id)
            val metaFile = sessionDir.resolve("meta.json")

            // Check if local version is newer
            if (Files.exists(metaFile)) {
                try {
                    val localMeta = mapper.readTree(Files.readString(metaFile))
                    val localUpdatedAt = localMeta.path("updatedAt").asLong(0L)
                    if (localUpdatedAt >= remote.updatedAt) continue // Local is newer or equal, skip
                } catch (_: Exception) { }
            }

            // Write remote session data
            try {
                Files.createDirectories(sessionDir)

                // Write meta
                val metaJson = mapper.createObjectNode().apply {
                    put("id", remote.id)
                    put("title", remote.title)
                    put("mode", remote.mode)
                    put("modelId", remote.modelId)
                    put("workspaceHash", remote.workspaceHash)
                    put("updatedAt", remote.updatedAt)
                    put("syncedFrom", "remote")
                    put("privacyMode", remote.privacyMode)
                }
                Files.writeString(metaFile, mapper.writeValueAsString(metaJson))

                // Write messages if provided
                if (remote.messagesBase64 != null) {
                    val compressed = java.util.Base64.getDecoder().decode(remote.messagesBase64)
                    val decompressed = gzipDecompress(compressed)
                    Files.write(sessionDir.resolve("messages.ndjson"), decompressed)
                }
            } catch (_: Exception) { continue }
        }
    }

    private fun deleteLocalSession(sessionsRoot: Path, sessionId: String) {
        val sessionDir = sessionsRoot.resolve(sessionId)
        if (Files.exists(sessionDir)) {
            sessionDir.toFile().deleteRecursively()
        }
    }

    private fun gzipCompress(data: ByteArray): ByteArray {
        val bos = java.io.ByteArrayOutputStream()
        java.util.zip.GZIPOutputStream(bos).use { it.write(data) }
        return bos.toByteArray()
    }

    private fun gzipDecompress(compressed: ByteArray): ByteArray {
        val bis = java.io.ByteArrayInputStream(compressed)
        val bos = java.io.ByteArrayOutputStream()
        java.util.zip.GZIPInputStream(bis).use { it.copyTo(bos) }
        return bos.toByteArray()
    }
}