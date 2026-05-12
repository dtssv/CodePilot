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

    fun newSession(
        workspaceHash: String,
        mode: String,
        modelId: String?,
    ): SessionHandle {
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

    fun appendMessage(
        handle: SessionHandle,
        role: String,
        content: String,
    ) {
        val payload =
            mapOf(
                "role" to role,
                "content" to content,
                "ts" to Instant.now().toString(),
            )
        appendNdjson(handle.dir.resolve("messages.ndjson"), payload)
    }

    fun appendEvent(
        handle: SessionHandle,
        event: String,
        data: Any,
    ) {
        appendNdjson(
            handle.dir.resolve("events.ndjson"),
            mapOf("event" to event, "data" to data, "ts" to Instant.now().toString()),
        )
    }

    fun savePlan(
        handle: SessionHandle,
        plan: Any?,
    ) {
        if (plan != null) writeJson(handle.dir.resolve("plan.json"), plan)
    }

    fun savePlanDelta(
        handle: SessionHandle,
        delta: Any?,
    ) {
        if (delta == null) return
        // Merge delta ops into existing plan, or persist as a new plan if none exists
        val planFile = handle.dir.resolve("plan.json")
        if (Files.exists(planFile)) {
            @Suppress("UNCHECKED_CAST")
            val existing =
                runCatching {
                    mapper.readValue(Files.readAllBytes(planFile), Map::class.java) as Map<String, Any>
                }.getOrNull()
            if (existing != null) {
                val mutablePlan = existing.toMutableMap()
                val existingOps = (existing["ops"] as? List<Any>)?.toMutableList() ?: mutableListOf()
                val deltaOps = (delta as? Map<String, Any>)?.get("ops") as? List<Any> ?: emptyList()
                existingOps.addAll(deltaOps)
                mutablePlan["ops"] = existingOps
                writeJson(planFile, mutablePlan)
                return
            }
        }
        // No existing plan — write delta as the initial plan
        writeJson(planFile, delta)
    }

    fun saveLedger(
        handle: SessionHandle,
        ledger: Any?,
    ) {
        if (ledger != null) writeJson(handle.dir.resolve("ledger.json"), ledger)
    }

    fun saveCheckpoint(
        handle: SessionHandle,
        checkpoint: Any,
    ) {
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
    fun appendStep(
        handle: SessionHandle,
        step: Map<String, Any?>,
    ) {
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
    fun completedToolCallIds(handle: SessionHandle): Set<String> =
        readSteps(handle)
            .mapNotNull { it["toolCallId"] as? String }
            .toSet()

    /** Save a session digest (context compression result). */
    fun saveDigest(
        handle: SessionHandle,
        digest: Any,
    ) {
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
    fun hasCheckpoint(handle: SessionHandle): Boolean = Files.exists(handle.dir.resolve("checkpoint.json"))

    /**
     * Build a complete resume payload for /v1/conversation/resume.
     * Includes: lastPlan, completedToolCalls, sessionDigest, taskLedger, lastAssistantTurnSummary.
     * This is the core of the checkpoint recovery mechanism.
     */
    fun buildResumePayload(
        handle: SessionHandle,
        userInput: String,
        modelId: String,
    ): Map<String, Any?> {
        val plan = loadPlan(handle)
        val ledger = loadLedger(handle)
        val digest = loadDigest(handle)
        val checkpoint = loadCheckpoint(handle)
        val completedSteps = readSteps(handle).filter { (it["ok"] as? Boolean) == true }

        // Build completedToolCalls list for idempotency
        val completedToolCalls =
            completedSteps.mapNotNull { step ->
                val toolCallId = step["toolCallId"] as? String ?: return@mapNotNull null
                mapOf(
                    "toolCallId" to toolCallId,
                    "name" to (step["toolName"] ?: ""),
                    "ok" to true,
                    "stepId" to (step["stepId"] ?: ""),
                )
            }

        // Extract last assistant turn summary (last 400 tokens worth)
        val messages = readMessages(handle)
        val lastAssistantMsg = messages.lastOrNull { it["role"] == "assistant" }
        val lastAssistantTurnSummary =
            lastAssistantMsg?.let { msg ->
                val content = msg["content"] as? String ?: ""
                if (content.length > 1600) content.takeLast(1600) else content
            }

        // Build the resume payload matching /v1/conversation/resume schema
        return mapOf(
            "sessionId" to handle.meta.id,
            "mode" to handle.meta.mode,
            "modelId" to modelId,
            "input" to userInput,
            "intent" to "continue",
            "lastPlan" to plan,
            "completedToolCalls" to completedToolCalls,
            "sessionDigest" to digest,
            "taskLedger" to ledger,
            "lastAssistantTurnSummary" to lastAssistantTurnSummary,
            "checkpoint" to checkpoint,
            "policy" to
                mapOf(
                    "requestCompact" to "auto",
                    "replanHint" to false,
                    "selfCheck" to true,
                    "askPolicy" to "prefer-ask",
                    "maxSteps" to 25,
                ),
        )
    }

    /**
     * Save a complete checkpoint snapshot after each Agent step.
     * The checkpoint contains everything needed to resume from this point.
     */
    fun saveStepCheckpoint(
        handle: SessionHandle,
        toolCallId: String,
        toolName: String,
        stepId: String,
        ok: Boolean,
        result: Any?,
    ) {
        // Append to steps.ndjson
        appendStep(
            handle,
            mapOf(
                "toolCallId" to toolCallId,
                "toolName" to toolName,
                "stepId" to stepId,
                "ok" to ok,
                "ts" to Instant.now().toString(),
            ),
        )

        // Update checkpoint.json with the latest recovery state
        val plan = loadPlan(handle)
        val ledger = loadLedger(handle)
        val digest = loadDigest(handle)
        val completedIds = completedToolCallIds(handle)

        saveCheckpoint(
            handle,
            mapOf(
                "lastToolCallId" to toolCallId,
                "lastToolName" to toolName,
                "lastStepOk" to ok,
                "completedToolCallIds" to completedIds.toList(),
                "planVersion" to plan?.get("version"),
                "ledgerCursor" to ledger?.get("cursor"),
                "hasDigest" to (digest != null),
                "ts" to Instant.now().toString(),
            ),
        )
    }

    /**
     * Estimate the current context token count for the session.
     * Used by the UI to display the context usage bar and trigger compression.
     */
    fun estimateTokenCount(handle: SessionHandle): Int {
        val messages = readMessages(handle)
        // Rough estimate: 1 token ≈ 4 characters for English, ≈ 2 characters for CJK
        var totalChars = 0
        for (msg in messages) {
            val content = msg["content"] as? String ?: continue
            totalChars += content.length
        }
        // Add plan and digest overhead
        val plan = loadPlan(handle)
        if (plan != null) totalChars += mapper.writeValueAsString(plan).length
        val digest = loadDigest(handle)
        if (digest != null) totalChars += mapper.writeValueAsString(digest).length

        // Conservative estimate: 1 token per 3 characters
        return totalChars / 3
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

    fun resolve(
        workspaceHash: String,
        sessionId: String,
    ): SessionHandle? {
        val dir = sessionDir(workspaceHash, sessionId)
        val meta = readMeta(dir) ?: return null
        return SessionHandle(dir, meta)
    }

    /** Update session metadata in place and persist. */
    fun updateMeta(
        handle: SessionHandle,
        block: (SessionMeta) -> Unit,
    ) {
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

    /**
     * Fork a new conversation branch from a specific message in the current session.
     * This creates a new session handle with:
     * - A new branchId
     * - A reference to the parent branch and the fork point message index
     * - Messages copied up to and including the fork point
     *
     * The new branch can then diverge from the original conversation independently.
     */
    fun forkFromMessage(
        handle: SessionHandle,
        messageIndex: Int,
    ): SessionHandle {
        val currentMessages = readMessages(handle)
        require(messageIndex in currentMessages.indices) {
            "Message index $messageIndex out of range (0..${currentMessages.size - 1})"
        }

        val newBranchId = "branch-${UUID.randomUUID().toString().take(8)}"
        val workspaceHash = handle.meta.workspaceHash
        val newHandle = newSession(workspaceHash, handle.meta.mode, handle.meta.modelId)

        // Copy messages up to and including the fork point
        val forkMessages = currentMessages.subList(0, messageIndex + 1)
        for (msg in forkMessages) {
            val role = msg["role"] as? String ?: "user"
            val content = msg["content"] as? String ?: ""
            appendMessage(newHandle, role, content)
        }

        // Update the new session's meta with branch info
        updateMeta(newHandle) { meta ->
            meta.title = "${handle.meta.title ?: "Session"} (fork at msg #$messageIndex)"
            // Use reflection or direct field set since branchId is val in data class
        }

        // Write branch metadata to the new session's meta
        val updatedMeta =
            newHandle.meta.copy(
                branchId = newBranchId,
                parentBranchId = handle.meta.branchId,
                parentMsgIndex = messageIndex,
            )
        newHandle.meta = updatedMeta
        writeJson(newHandle.dir.resolve("meta.json"), updatedMeta)

        // Save a branch map file for tracking all branches of the original session
        val branchMapFile = handle.dir.resolve("branches.json")
        val branches =
            if (Files.exists(branchMapFile)) {
                @Suppress("UNCHECKED_CAST")
                runCatching {
                    mapper.readValue(Files.readAllBytes(branchMapFile), Map::class.java) as Map<String, Any>
                }.getOrNull() ?: emptyMap()
            } else {
                emptyMap()
            }

        val mutableBranches = branches.toMutableMap()

        @Suppress("UNCHECKED_CAST")
        val branchList =
            (mutableBranches["branches"] as? List<Map<String, Any?>>)?.toMutableList()
                ?: mutableListOf()
        branchList.add(
            mapOf(
                "branchId" to newBranchId,
                "sessionId" to newHandle.meta.id,
                "parentBranchId" to handle.meta.branchId,
                "forkMsgIndex" to messageIndex,
                "createdAt" to Instant.now().toString(),
            ),
        )
        mutableBranches["branches"] = branchList
        writeJson(branchMapFile, mutableBranches)

        return newHandle
    }

    /**
     * List all branches of a session (including the main branch).
     */
    fun listBranches(handle: SessionHandle): List<BranchInfo> {
        val branchMapFile = handle.dir.resolve("branches.json")
        if (!Files.exists(branchMapFile)) {
            return listOf(BranchInfo("main", handle.meta.id, null, null))
        }

        @Suppress("UNCHECKED_CAST")
        val branches =
            runCatching {
                mapper.readValue(Files.readAllBytes(branchMapFile), Map::class.java) as Map<String, Any>
            }.getOrNull() ?: return listOf(BranchInfo("main", handle.meta.id, null, null))

        val result = mutableListOf(BranchInfo("main", handle.meta.id, null, null))

        @Suppress("UNCHECKED_CAST")
        val branchList = branches["branches"] as? List<Map<String, Any?>> ?: return result
        for (branch in branchList) {
            result.add(
                BranchInfo(
                    branchId = branch["branchId"] as? String ?: "unknown",
                    sessionId = branch["sessionId"] as? String ?: "",
                    parentBranchId = branch["parentBranchId"] as? String,
                    forkMsgIndex = branch["forkMsgIndex"] as? Int,
                ),
            )
        }
        return result
    }

    data class BranchInfo(
        val branchId: String,
        val sessionId: String,
        val parentBranchId: String?,
        val forkMsgIndex: Int?,
    )

    /** Delete a session directory. */
    fun delete(
        workspaceHash: String,
        sessionId: String,
    ) {
        val dir = sessionDir(workspaceHash, sessionId)
        if (Files.exists(dir)) dir.toFile().deleteRecursively()
    }

    private fun sessionDir(
        workspaceHash: String,
        sessionId: String,
    ): Path = settingsRoot().resolve(workspaceHash).resolve(sessionId)

    private fun settingsRoot(): Path = CodePilotSettings.getInstance().sessionRootPath()

    private fun appendNdjson(
        file: Path,
        payload: Any,
    ) {
        Files.createDirectories(file.parent)
        val line = mapper.writeValueAsString(payload) + "\n"
        val bytes =
            if (crypto.isEncryptionEnabled()) {
                // For encrypted NDJSON, each line is individually encrypted and Base64-encoded
                (crypto.encryptText(line) + "\n").toByteArray(StandardCharsets.UTF_8)
            } else {
                line.toByteArray(StandardCharsets.UTF_8)
            }
        Files.write(file, bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND)
    }

    private fun writeJson(
        file: Path,
        payload: Any,
    ) {
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

    data class SessionHandle(
        val dir: Path,
        var meta: SessionMeta,
    )

    data class SessionMeta(
        val id: String,
        val workspaceHash: String,
        var createdAt: String,
        var updatedAt: String,
        var lastMessageAt: String?,
        val mode: String,
        val modelId: String?,
        var title: String?,
        val branchId: String = "main",
        val parentBranchId: String? = null,
        val parentMsgIndex: Int? = null,
    )

    companion object {
        @JvmStatic fun getInstance(): SessionStore = service()
    }

    // ─── Message Search ────────────────────────────────────────────────

    /**
     * Search messages across all sessions for a given query string.
     * Returns matching messages with their session context.
     * Used for Ctrl+F-style search in the Chat history.
     */
    fun searchMessages(
        workspaceHash: String,
        query: String,
        limit: Int = 50,
    ): List<MessageSearchResult> {
        if (query.isBlank()) return emptyList()
        val queryLower = query.lowercase()
        val results = mutableListOf<MessageSearchResult>()

        val workspaceDir = settingsRoot().resolve(workspaceHash)
        if (!Files.exists(workspaceDir)) return emptyList()

        Files.list(workspaceDir).use { dirs ->
            dirs.filter { Files.isDirectory(it) }.forEach { sessionDir ->
                val messagesFile = sessionDir.resolve("messages.ndjson")
                if (!Files.exists(messagesFile)) return@forEach

                val sessionId = sessionDir.fileName.toString()
                val meta = runCatching {
                    mapper.readValue(Files.readAllBytes(sessionDir.resolve("meta.json")), SessionMeta::class.java)
                }.getOrNull() ?: return@forEach

                var msgIdx = 0
                Files.readAllLines(messagesFile).filter { it.isNotBlank() }.forEach { line ->
                    val msg = runCatching {
                        mapper.readValue(line, Map::class.java) as Map<String, Any>
                    }.getOrNull()
                    if (msg != null) {
                        val content = (msg["content"] as? String ?: "").lowercase()
                        if (content.contains(queryLower)) {
                            results.add(MessageSearchResult(
                                sessionId = sessionId,
                                sessionTitle = meta.title ?: "Untitled",
                                messageIndex = msgIdx,
                                role = msg["role"] as? String ?: "unknown",
                                content = (msg["content"] as? String ?: "").take(200),
                                timestamp = msg["ts"] as? String,
                            ))
                            if (results.size >= limit) return@forEach
                        }
                    }
                    msgIdx++
                }
            }
        }

        return results.sortedByDescending { it.timestamp }
    }

    data class MessageSearchResult(
        val sessionId: String,
        val sessionTitle: String,
        val messageIndex: Int,
        val role: String,
        val content: String,
        val timestamp: String?,
    )
}
