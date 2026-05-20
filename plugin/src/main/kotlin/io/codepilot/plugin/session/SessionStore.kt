package io.codepilot.plugin.session

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
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
    private val log = logger<SessionStore>()

    fun newSession(
        workspaceHash: String,
        mode: String,
        modelId: String?,
        modelSource: String? = null,
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
                modelSource = modelSource,
                title = null,
            )
        writeJson(root.resolve("meta.json"), meta)
        return SessionHandle(root, meta)
    }

    fun appendMessage(
        handle: SessionHandle,
        role: String,
        content: String,
        extra: Map<String, Any?> = emptyMap(),
    ) {
        val payload =
            mutableMapOf<String, Any?>(
                "role" to role,
                "content" to content,
                "ts" to Instant.now().toString(),
            )
        payload.putAll(extra)
        appendNdjson(handle.dir.resolve("messages.ndjson"), payload.toMap())
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

    /**
     * Rebuild persisted tool cards for session replay: merges started + result steps so WebUI
     * shows command, cwd, stdout/stderr, and deny/skip state after reload.
     */
    @Suppress("UNCHECKED_CAST")
    fun mergeToolCallsFromSteps(steps: List<Map<String, Any>>): List<Map<String, Any>> {
        val merged = linkedMapOf<String, MutableMap<String, Any?>>()
        for (step in steps) {
            val id = step["toolCallId"] as? String ?: continue
            val entry = merged.getOrPut(id) { mutableMapOf("id" to id) }
            if (step["started"] == true) {
                entry["name"] = step["toolName"] ?: "unknown"
                step["args"]?.let { entry["args"] = it }
            }
            if (step.containsKey("ok")) {
                val ok = step["ok"] == true
                entry["status"] = if (ok) "success" else "error"
                step["result"]?.let { entry["result"] = it }
                entry["executionState"] = deriveExecutionState(ok, step["result"] as? Map<String, Any?>)
            }
        }
        return merged.values.map { it.filterValues { it != null }.toMap() as Map<String, Any> }
    }

    /**
     * Merge persisted message toolCalls with steps.ndjson (steps win for result/status/args).
     */
    @Suppress("UNCHECKED_CAST")
    fun mergeToolCallsPersisted(
        msgToolCalls: List<Map<String, Any>>?,
        steps: List<Map<String, Any>>,
    ): List<Map<String, Any>> {
        val fromSteps = mergeToolCallsFromSteps(steps)
        if (msgToolCalls.isNullOrEmpty()) {
            return fromSteps
        }
        if (fromSteps.isEmpty()) {
            return msgToolCalls
        }
        val stepById = fromSteps.associateBy { it["id"]?.toString().orEmpty() }
        return msgToolCalls.map { tc ->
            val id = tc["id"]?.toString().orEmpty()
            val merged = stepById[id] ?: return@map tc
            val out = tc.toMutableMap()
            merged["result"]?.let { out["result"] = it }
            merged["status"]?.let { out["status"] = it }
            merged["executionState"]?.let { out["executionState"] = it }
            if (out["args"] == null) {
                merged["args"]?.let { out["args"] = it }
            }
            val name = out["name"]?.toString()
            if (name.isNullOrBlank() || name == "unknown") {
                merged["name"]?.let { out["name"] = it }
            }
            out
        }
    }

    private fun deriveExecutionState(ok: Boolean, result: Map<String, Any?>?): String {
        if (ok) return "success"
        val stderr = result?.get("stderr")?.toString() ?: ""
        return when {
            stderr.contains("用户已跳过") || stderr.contains("Skipped by user") -> "skipped"
            stderr.contains("用户已拒绝") || stderr.contains("Denied:") -> "denied"
            else -> "error"
        }
    }

    /** Save a session digest (context compression result). */
    fun saveDigest(
        handle: SessionHandle,
        digest: Any,
    ) {
        writeJson(handle.dir.resolve("digest.json"), digest)
    }

    /**
     * ★ Integration: Compress session context using LlmContextCompressor
     * when token count exceeds the budget threshold (80%).
     * Called before sending requests to the backend.
     */
    fun compressIfNeeded(handle: SessionHandle, tokenBudget: Int = 24000): CompressionResult? {
        val estimated = estimateTokenCount(handle)
        if (estimated < tokenBudget * 0.8) return null // No compression needed

        val messages = readMessages(handle)
        val targetTokens = (tokenBudget * 0.5).toInt() // Compress to 50% of budget
        val request = LlmContextCompressor.CompressionRequest(
            messages = messages,
            targetTokens = targetTokens,
        )
        val result = LlmContextCompressor.compress(request)
        if (result.method != "none" && result.summary.isNotBlank()) {
            saveDigest(handle, mapOf(
                "summary" to result.summary,
                "method" to result.method,
                "compressionRatio" to result.compressionRatio,
            ))
        }
        return CompressionResult(
            summary = result.summary,
            method = result.method,
            compressionRatio = result.compressionRatio,
        )
    }

    data class CompressionResult(
        val summary: String,
        val method: String,
        val compressionRatio: Double,
    )

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

    data class RecoveryAssessment(
        /** exact | soft | none */
        val mode: String,
        val hasLocalCheckpoint: Boolean,
        val hasContinuationToken: Boolean,
    )

    /** Classify how well this session can be resumed after an interrupt. */
    fun assessRecovery(handle: SessionHandle): RecoveryAssessment {
        val token = findContinuationToken(handle)
        if (!token.isNullOrBlank()) {
            return RecoveryAssessment("exact", hasCheckpoint(handle), true)
        }
        val soft =
            hasCheckpoint(handle) ||
                loadPlan(handle) != null ||
                readMessages(handle).isNotEmpty()
        return if (soft) {
            RecoveryAssessment("soft", hasCheckpoint(handle), false)
        } else {
            RecoveryAssessment("none", false, false)
        }
    }

    /** Best-effort continuation token from local checkpoint or latest graph-*.json. */
    fun findContinuationToken(handle: SessionHandle): String? {
        loadCheckpoint(handle)?.get("continuationToken")?.toString()?.trim()?.takeIf { it.isNotBlank() }?.let {
            return it
        }
        val plansDir = handle.dir.resolve("plans")
        if (!Files.isDirectory(plansDir)) return null
        return try {
            Files.list(plansDir)
                .filter { it.fileName.toString().startsWith("graph-") && it.fileName.toString().endsWith(".json") }
                .sorted(Comparator.reverseOrder())
                .findFirst()
                .map { path ->
                    val node = mapper.readTree(Files.readString(path))
                    node.path("continuationToken").asText(null)
                        ?: node.path("awaiting").path("continuationToken").asText(null)
                }
                .orElse(null)
                ?.trim()
                ?.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            log.warn("findContinuationToken failed: ${e.message}")
            null
        }
    }

    /**
     * Persist recovery snapshot when SSE closes abnormally (deploy / network).
     * Merges graph state and tool-step metadata into checkpoint.json.
     */
    fun persistAbnormalCloseSnapshot(
        handle: SessionHandle,
        graphSnapshot: com.fasterxml.jackson.databind.JsonNode?,
    ) {
        val existing = loadCheckpoint(handle)?.toMutableMap() as? MutableMap<String, Any?> ?: mutableMapOf<String, Any?>()
        existing["reason"] = "abnormal_close"
        existing["ts"] = Instant.now().toString()
        existing["completedToolCallIds"] = completedToolCallIds(handle).toList()
        graphSnapshot?.let { node ->
            @Suppress("UNCHECKED_CAST")
            existing["graphState"] = mapper.convertValue(node, Map::class.java) as Map<String, Any?>
            node.path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }?.let {
                existing["continuationToken"] = it
            }
            node.path("resumeNextNode").asText(null)?.trim()?.takeIf { it.isNotBlank() }?.let {
                existing["resumeNextNode"] = it
            }
        }
        saveCheckpoint(handle, existing)
    }

    /**
     * Build a complete resume payload for /v1/conversation/resume.
     * Includes: lastPlan, completedToolCalls, sessionDigest, taskLedger, lastAssistantTurnSummary.
     * This is the core of the checkpoint recovery mechanism.
     *
     * If the session has a graph awaiting state (awaiting_user_input), includes
     * the continuationToken and graphState so the backend can resume from the
     * exact interrupt point.
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

        // ── Load graph state for interrupt-resume ──
        // Read graph state directly from disk (SessionStore is APP-level, no project reference)
        val plansDir = handle.dir.resolve("plans")
        var continuationToken: String? = null
        var isAwaiting = false
        var graphStateMap: Map<String, Any?> = emptyMap()

        try {
            if (Files.isDirectory(plansDir)) {
                val latestGraph = Files.list(plansDir)
                    .filter { it.fileName.toString().startsWith("graph-") && it.fileName.toString().endsWith(".json") }
                    .sorted(Comparator.reverseOrder())
                    .findFirst()
                    .orElse(null)

                if (latestGraph != null) {
                    val graphJson = mapper.readTree(Files.readString(latestGraph))
                    // Check if the graph is in awaiting state
                    val awaitingNode = graphJson.path("awaiting")
                    isAwaiting = !awaitingNode.isMissingNode && !awaitingNode.isNull
                    // Extract continuationToken from top level or from awaiting
                    continuationToken = graphJson.path("continuationToken").asText(null)
                        ?: awaitingNode.path("continuationToken").asText(null)
                    // Convert graph state to map
                    graphStateMap = mapper.convertValue(graphJson, Map::class.java) as Map<String, Any?>
                }
            }
        } catch (e: Exception) {
            log.warn("Failed to load graph state for resume: ${e.message}")
        }

        // Determine intent based on whether we're resuming from an interrupt point
        val intent = if (isAwaiting && continuationToken != null) "answer" else "continue"

        // Build the resume payload matching /v1/conversation/resume schema
        val payload = mutableMapOf<String, Any?>(
            "sessionId" to handle.meta.id,
            "mode" to handle.meta.mode,
            "modelId" to modelId,
            "modelSource" to handle.meta.modelSource,
            "input" to userInput,
            "intent" to intent,
            "lastPlanDigest" to plan,
            "completedToolCallsTail" to completedToolCalls,
            "sessionDigest" to digest,
            "taskLedger" to ledger,
            "lastAssistantTurnSummary" to lastAssistantTurnSummary,
            "policy" to
                mapOf(
                    "requestCompact" to "auto",
                    "replanHint" to false,
                    "selfCheck" to true,
                    "askPolicy" to "prefer-ask",
                    "maxSteps" to 25,
                    "engine" to "graph",
                ),
        )

        // Include continuationToken if resuming from an interrupt point
        if (continuationToken != null) {
            payload["continuationToken"] = continuationToken
        }

        // Include graphState for the backend to restore graph execution
        if (graphStateMap.isNotEmpty()) {
            payload["graphState"] = graphStateMap
        }

        return payload.toMap()
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
        // Use TokenEstimator for accurate BPE tokenization (jtokkit when available)
        var total = TokenEstimator.countMessages(messages)
        // Add plan and digest overhead
        val plan = loadPlan(handle)
        if (plan != null) total += TokenEstimator.countTokens(mapper.writeValueAsString(plan))
        val digest = loadDigest(handle)
        if (digest != null) total += TokenEstimator.countTokens(mapper.writeValueAsString(digest))
        return total
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

    /**
     * ★ Integration: Push session changes to cloud via ConversationHistorySync.
     * Called after significant session events (new message, save plan, etc.)
     * to ensure cross-device sync. Non-blocking, best-effort.
     */
    fun triggerSync(project: Project) {
        Thread({
            try {
                ConversationHistorySync.sync(project)
            } catch (_: Exception) { /* Non-critical */ }
        }, "codepilot-sync-push").apply { isDaemon = true; start() }
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
                rootSessionId = handle.meta.rootSessionId ?: handle.meta.id,
            )
        newHandle.meta = updatedMeta
        writeJson(newHandle.dir.resolve("meta.json"), updatedMeta)

        // Save branch metadata on the root session so every fork can see siblings.
        val rootHandle = resolve(workspaceHash, handle.meta.rootSessionId ?: handle.meta.id) ?: handle
        val branchMapFile = rootHandle.dir.resolve("branches.json")
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
        val rootHandle = resolve(handle.meta.workspaceHash, handle.meta.rootSessionId ?: handle.meta.id) ?: handle
        val branchMapFile = rootHandle.dir.resolve("branches.json")
        if (!Files.exists(branchMapFile)) {
            return listOf(BranchInfo("main", rootHandle.meta.id, null, null))
        }

        @Suppress("UNCHECKED_CAST")
        val branches =
            runCatching {
                mapper.readValue(Files.readAllBytes(branchMapFile), Map::class.java) as Map<String, Any>
            }.getOrNull() ?: return listOf(BranchInfo("main", rootHandle.meta.id, null, null))

        val result = mutableListOf(BranchInfo("main", rootHandle.meta.id, null, null))

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
        val modelSource: String? = null,
        var title: String?,
        val branchId: String = "main",
        val parentBranchId: String? = null,
        val parentMsgIndex: Int? = null,
        val rootSessionId: String? = null,
        /** Whether the session is currently running (SSE stream active). */
        var running: Boolean = false,
        /** Whether the session was abnormally terminated (stream closed without done event). */
        var abnormalTermination: Boolean? = null,
        /** P2-09: user can pin important sessions in SessionSidebarV2. */
        var pinned: Boolean = false,
        /** P2-09: archived sessions are hidden by default but kept on disk. */
        var archived: Boolean = false,
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
