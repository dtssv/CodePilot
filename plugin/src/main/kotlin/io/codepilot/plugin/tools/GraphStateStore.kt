package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.nio.file.Files
import java.nio.file.Path

/**
 * Manages the client-side Graph state (plans/graph-{n}.json) and gathered data
 * (gathered/ directory). Mirrors the server-side GraphState in Redis, but the
 * plugin-side copy is the authority after Redis TTL expiry.
 *
 * Responsibilities:
 *   - Merge SSE events (graph_plan, graph_transition, graph_verify, graph_phase_done,
 *     graph_info_result) into a coherent local GraphState
 *   - Persist to session directory as plans/graph-{n}.json
 *   - Provide the graphState payload for /conversation/run and /conversation/resume
 *   - Track phase progress for UI display
 */
class GraphStateStore(
    private val project: Project,
    private val sessionDir: Path,
) {
    private val log = Logger.getInstance(GraphStateStore::class.java)
    private val mapper = ObjectMapper()
    private var state: ObjectNode = mapper.createObjectNode()
    private var version = 0

    /** Initialize from disk if a previous graph-*.json exists. */
    fun loadLatest() {
        val plansDir = sessionDir.resolve("plans")
        if (!Files.isDirectory(plansDir)) return
        val latest =
            Files
                .list(plansDir)
                .filter { it.fileName.toString().startsWith("graph-") && it.fileName.toString().endsWith(".json") }
                .sorted(Comparator.reverseOrder())
                .findFirst()
                .orElse(null) ?: return
        try {
            state = mapper.readTree(Files.readString(latest)) as ObjectNode
            version = state.path("_version").asInt(0)
            log.info("Loaded graph state from $latest (version=$version)")
        } catch (e: Exception) {
            log.warn("Failed to load graph state from $latest", e)
        }

        // ★ Integration: Merge custom user graph nodes into the pipeline
        injectCustomGraphNodes()
    }

    /**
     * ★ Integration with UserGraphNodeRegistry:
     * Inject custom nodes from .codepilot/graph-nodes.json into the graph pipeline.
     * Custom nodes are inserted after their specified afterNode in the builtin pipeline.
     */
    private fun injectCustomGraphNodes() {
        try {
            val customNodes = io.codepilot.plugin.graph.UserGraphNodeRegistry.loadCustomNodes(project)
            if (customNodes.isEmpty()) return

            // Store custom node definitions in state for the backend to consume
            val customNodesArray = mapper.createArrayNode()
            for (node in customNodes) {
                val nodeJson = mapper.createObjectNode().apply {
                    put("id", node.id)
                    put("label", node.label)
                    put("afterNode", node.afterNode)
                    put("condition", node.condition)
                    put("prompt", node.prompt)
                    put("onFailure", node.onFailure)
                    put("maxRetries", node.maxRetries)
                    put("timeout", node.timeout)
                }
                val toolsArray = mapper.createArrayNode()
                node.tools.forEach { toolsArray.add(it) }
                nodeJson.set<com.fasterxml.jackson.databind.node.ArrayNode>("tools", toolsArray)
                customNodesArray.add(nodeJson)
            }
            state.set<com.fasterxml.jackson.databind.node.ArrayNode>("customNodes", customNodesArray)

            // Build the full pipeline (builtin + custom) and store it
            val fullPipeline = io.codepilot.plugin.graph.UserGraphNodeRegistry.buildFullPipeline(project)
            val pipelineArray = mapper.createArrayNode()
            fullPipeline.forEach { pipelineArray.add(it) }
            state.set<com.fasterxml.jackson.databind.node.ArrayNode>("pipeline", pipelineArray)

            persist()
            log.info("Injected ${customNodes.size} custom graph nodes into pipeline: $fullPipeline")
        } catch (e: Exception) {
            log.warn("Failed to inject custom graph nodes", e)
        }
    }

    /** Apply a graph_plan event (full plan with phases). */
    fun applyGraphPlan(data: JsonNode) {
        state.set<JsonNode>("phases", data.path("phases"))
        state.put("graphId", data.path("graphId").asText(""))
        state.put("currentNode", "planning")
        state.put("phaseCursor", "")
        persist()
    }

    /** Apply a graph_transition event. */
    fun applyTransition(data: JsonNode) {
        state.put("currentNode", data.path("to").asText(""))
        val phaseId = data.path("phaseId").asText("")
        if (phaseId.isNotEmpty()) state.put("phaseCursor", phaseId)

        // Append to history
        val history = state.withArray("history")
        val entry = mapper.createObjectNode()
        entry.put("seq", history.size() + 1)
        entry.put("from", data.path("from").asText(""))
        entry.put("to", data.path("to").asText(""))
        entry.put("phaseId", phaseId)
        entry.put("reason", data.path("reason").asText(""))
        entry.put("at", System.currentTimeMillis())
        history.add(entry)
        persist()
    }

    /** Apply a graph_verify event. */
    fun applyVerify(data: JsonNode) {
        val phaseId = data.path("phaseId").asText("")
        val ok = data.path("ok").asBoolean(false)
        if (!ok) {
            // Increment attempts
            val attempts = state.withObject("attempts")
            val current = attempts.path(phaseId).asInt(0)
            (attempts as ObjectNode).put(phaseId, current + 1)
        }
        persist()
    }

    /** Apply a graph_phase_done event. */
    fun applyPhaseDone(data: JsonNode) {
        val phaseId = data.path("phaseId").asText("")
        val completed = state.withArray("completedPhases")
        completed.add(phaseId)
        persist()
    }

    /** Apply a graph_info_result event (store gathered info metadata). */
    fun applyInfoResult(data: JsonNode) {
        val gathered = state.withArray("gathered")
        val results = data.path("results")
        if (results.isArray) {
            for (r in results) {
                gathered.add(r.deepCopy())
            }
        }
        persist()
    }

    /** Apply graph_checkpoint SSE (phase-boundary soft checkpoint). */
    fun applyCheckpoint(data: JsonNode) {
        data.path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }?.let {
            state.put("continuationToken", it)
        }
        data.path("nextNode").asText(null)?.trim()?.takeIf { it.isNotBlank() }?.let {
            state.put("resumeNextNode", it)
        }
        data.path("kind").asText(null)?.let { state.put("lastCheckpointKind", it) }
        val journal = data.path("graphExecutionJournal")
        if (!journal.isMissingNode && journal.isObject) {
            state.set<JsonNode>("graphExecutionJournal", journal.deepCopy())
        }
        persist()
    }

    /** Apply awaiting state (from done.reason=awaiting_user_input). */
    fun applyAwaiting(donePayload: JsonNode) {
        state.set<JsonNode>("awaiting", donePayload)
        state.put("currentNode", "awaitUserInput")
        // Extract and persist continuationToken at top level for easy access during resume
        val token = donePayload.path("continuationToken").asText(null)
        if (token != null) {
            state.put("continuationToken", token)
        }
        // Also extract nextNode from awaiting if present
        val awaitingNode = donePayload.path("awaiting")
        if (awaitingNode.isObject) {
            val nextNode = awaitingNode.path("nextNode").asText(null)
            if (nextNode != null) {
                state.put("resumeNextNode", nextNode)
            }
        }
        persist()
    }

    /** Clear the awaiting state after user has responded. */
    fun clearAwaiting() {
        state.remove("awaiting")
        state.remove("continuationToken")
        state.remove("resumeNextNode")
        state.put("currentNode", "")
        persist()
    }

    /** Get the current graphState for sending in request payloads. */
    fun snapshot(): JsonNode = state.deepCopy()

    /** Get current phase cursor for UI display. */
    fun currentPhase(): String = state.path("phaseCursor").asText("")

    /** Get current node for UI display. */
    fun currentNode(): String = state.path("currentNode").asText("")

    /** Check if awaiting user input. */
    fun isAwaiting(): Boolean = !state.path("awaiting").isMissingNode

    /**
     * Apply user edits to the plan (from PlanPanel UI).
     * Per 01-§6.1: "用户可在 Plan / Ledger 面板里勾选/编辑/暂停/追问"
     * Stores user edits under "userEdits" and marks them for next Agent turn.
     */
    fun applyUserPlanEdits(edits: JsonNode) {
        val userEdits = state.withArray("userEdits")
        // Each edit: { phaseId, action (skip/modify/reprioritize), detail? }
        if (edits.isArray) {
            for (edit in edits) {
                userEdits.add(edit.deepCopy())
            }
        } else if (edits.isObject) {
            userEdits.add(edits.deepCopy())
        }
        persist()
    }

    /**
     * Get accumulated user plan edits and clear them (consumed by next Agent turn).
     */
    fun consumeUserPlanEdits(): JsonNode {
        val edits: JsonNode = state.path("userEdits").deepCopy<JsonNode>()
        state.remove("userEdits")
        persist()
        return edits
    }

    /** Check if there are pending user plan edits. */
    fun hasUserPlanEdits(): Boolean = state.has("userEdits") && state.path("userEdits").size() > 0

    private fun persist() {
        version++
        state.put("_version", version)
        state.put("_updatedAt", System.currentTimeMillis())
        val plansDir = sessionDir.resolve("plans")
        Files.createDirectories(plansDir)
        val file = plansDir.resolve("graph-$version.json")
        Files.writeString(file, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(state))
    }
}
