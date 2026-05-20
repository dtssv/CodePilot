package io.codepilot.plugin.apply

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import io.codepilot.plugin.tools.PathGuard
import io.codepilot.plugin.tools.ToolViolation
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * P0-03 — In-memory staging area for file mutations so the WebUI can present a
 * per-hunk accept/reject UI before any bytes hit disk.
 *
 * Lifecycle:
 *  1. ToolDispatcher calls [stage] (instead of writing immediately) when the
 *     `stageBeforeApply` setting is on.
 *  2. The staging entry is added to [pending] and broadcast over the EventBus as a
 *     `pending.update` envelope.
 *  3. The WebUI lets the user toggle hunk acceptance via [setHunkStatus] and
 *     finally commits via [applyFile] / [applyAll], or discards via [rejectFile].
 *  4. After successful commit, the entry moves to [history] for [undoTurn].
 *
 * Thread-safety: state is held in [ConcurrentHashMap]; the actual disk write is
 * dispatched onto the EDT (the only place a [WriteCommandAction] may run).
 */
@Service(Service.Level.PROJECT)
class PatchStaging(private val project: Project) {
    private val log = logger<PatchStaging>()
    private val bus get() = EventBus.getInstance(project)

    /** Per-hunk status. */
    enum class HunkStatus { PENDING, ACCEPTED, REJECTED }

    /** Logical operation type. */
    enum class Op { CREATE, WRITE, DELETE }

    /** Snapshot of a hunk that can be cheaply serialized to the WebUI. */
    data class HunkSnapshot(
        val id: String,
        val oldStart: Int,
        val oldCount: Int,
        val newStart: Int,
        val newCount: Int,
        val changes: List<DiffUtil.Change>,
        var status: HunkStatus = HunkStatus.PENDING,
    )

    /** A pending edit on a single file, owned by a turn. */
    data class Pending(
        val pendingId: String,
        val turnId: String,
        val path: String,
        val op: Op,
        val oldContent: String,
        var newContent: String,
        var hunks: MutableList<HunkSnapshot>,
        val createdAt: Long = System.currentTimeMillis(),
    )

    /** A successfully-applied entry, kept so the user can undo the whole turn. */
    data class HistoryEntry(
        val pendingId: String,
        val turnId: String,
        val path: String,
        val op: Op,
        /** Content the file had before our commit. */
        val previousContent: String,
        /** Content the file had immediately after our commit (for verification). */
        val committedContent: String,
        val ts: Long = System.currentTimeMillis(),
    )

    private val pending = ConcurrentHashMap<String, Pending>()
    private val history = ConcurrentHashMap<String, MutableList<HistoryEntry>>()

    // ---------------- staging ---------------- //

    /**
     * Stage a write. Returns the new pending id; the caller should NOT also write
     * the file — [applyFile] / [applyAll] does that once the user confirms.
     */
    fun stage(turnId: String, path: String, newContent: String, op: Op = Op.WRITE): String {
        val (current, exists) = readCurrent(path)
        val effectiveOp = when {
            op == Op.DELETE -> Op.DELETE
            !exists -> Op.CREATE
            else -> Op.WRITE
        }
        val oldFor = if (exists) current else ""
        val newFor = if (effectiveOp == Op.DELETE) "" else newContent
        val hunks = DiffUtil.diff(oldFor, newFor).map {
            HunkSnapshot(it.id, it.oldStart, it.oldCount, it.newStart, it.newCount, it.changes)
        }.toMutableList()
        val id = "pend-${UUID.randomUUID().toString().take(8)}"
        val entry = Pending(
            pendingId = id,
            turnId = turnId,
            path = path,
            op = effectiveOp,
            oldContent = oldFor,
            newContent = newFor,
            hunks = hunks,
        )
        pending[id] = entry
        broadcastPending()
        return id
    }

    fun setHunkStatus(pendingId: String, hunkId: String, status: HunkStatus): Boolean {
        val p = pending[pendingId] ?: return false
        val h = p.hunks.firstOrNull { it.id == hunkId } ?: return false
        h.status = status
        broadcastPending()
        return true
    }

    /** Accept or reject every hunk in one shot. */
    fun setAllHunks(pendingId: String, status: HunkStatus): Boolean {
        val p = pending[pendingId] ?: return false
        p.hunks.forEach { it.status = status }
        broadcastPending()
        return true
    }

    fun pendingForTurn(turnId: String): List<Pending> =
        pending.values.filter { it.turnId == turnId }.toList()

    /** Accept every hunk for all pending files in a turn (used before apply-all). */
    fun acceptAllForTurn(turnId: String) {
        pendingForTurn(turnId).forEach { setAllHunks(it.pendingId, HunkStatus.ACCEPTED) }
    }

    /**
     * Agent doc-generation: auto-accept and commit CREATE files under `doc/`.
     * Avoids requiring manual Accept + Apply for markdown design deliverables.
     */
    fun autoApplyDocCreates(turnId: String): Map<String, Any?> {
        val entries = pendingForTurn(turnId)
        var committed = 0
        for (entry in entries) {
            val norm = entry.path.replace('\\', '/')
            val isDoc = norm.startsWith("doc/") || norm.contains("/doc/")
            if (isDoc && entry.op == Op.CREATE) {
                setAllHunks(entry.pendingId, HunkStatus.ACCEPTED)
                val r = applyFile(entry.pendingId)
                if (r["ok"] == true) committed++
            }
        }
        return mapOf("ok" to true, "committed" to committed, "turnId" to turnId)
    }

    // ---------------- apply ---------------- //

    /**
     * Commit a single pending file. Only [HunkStatus.ACCEPTED] hunks are kept;
     * remaining hunks are dropped (treated as REJECTED). Returns a status map.
     */
    fun applyFile(pendingId: String): Map<String, Any?> {
        val p = pending[pendingId]
            ?: return mapOf("ok" to false, "error" to "pending not found: $pendingId")
        val accepted = p.hunks.filter { it.status == HunkStatus.ACCEPTED }.map { it.id }.toSet()
        if (accepted.isEmpty() && p.hunks.isNotEmpty() && p.op != Op.DELETE) {
            // Nothing accepted: treat as reject so we don't write old content needlessly.
            return rejectFile(pendingId)
        }
        val target = if (p.op == Op.DELETE) {
            ""
        } else {
            val hunkObjs = p.hunks.map {
                DiffUtil.Hunk(it.id, it.oldStart, it.oldCount, it.newStart, it.newCount, it.changes)
            }
            DiffUtil.applyAccepted(p.oldContent, hunkObjs, accepted)
        }
        return commit(p, target)
    }

    /** Commit every pending entry in a turn. */
    fun applyAll(turnId: String): Map<String, Any?> {
        val entries = pending.values.filter { it.turnId == turnId }.toList()
        val results = entries.map { applyFile(it.pendingId) }
        return mapOf(
            "ok" to results.all { it["ok"] == true },
            "count" to entries.size,
            "results" to results,
        )
    }

    fun rejectFile(pendingId: String): Map<String, Any?> {
        val removed = pending.remove(pendingId)
            ?: return mapOf("ok" to false, "error" to "pending not found: $pendingId")
        broadcastPending()
        emitApplyResult(removed, "rejected", null)
        return mapOf("ok" to true, "pendingId" to pendingId)
    }

    /** Recompute hunks against current disk content (in case the file changed). */
    fun reapply(pendingId: String): Map<String, Any?> {
        val p = pending[pendingId]
            ?: return mapOf("ok" to false, "error" to "pending not found: $pendingId")
        val (current, _) = readCurrent(p.path)
        val refreshed = DiffUtil.diff(current, p.newContent).map {
            HunkSnapshot(it.id, it.oldStart, it.oldCount, it.newStart, it.newCount, it.changes)
        }.toMutableList()
        // Keep prior accept/reject decisions where hunk shape lines up by id.
        val prior = p.hunks.associateBy { it.id }
        for (h in refreshed) prior[h.id]?.let { h.status = it.status }
        p.hunks = refreshed
        broadcastPending()
        return mapOf("ok" to true, "pendingId" to pendingId, "hunks" to refreshed.size)
    }

    /** Undo every committed entry for a turn (in reverse order). */
    fun undoTurn(turnId: String): Map<String, Any?> {
        val entries = history[turnId]?.toList().orEmpty()
        if (entries.isEmpty()) return mapOf("ok" to true, "count" to 0)
        var ok = true
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project) {
                for (e in entries.asReversed()) {
                    try {
                        when (e.op) {
                            Op.DELETE -> writeDisk(e.path, e.previousContent, allowCreate = true)
                            Op.CREATE -> deleteDisk(e.path)
                            Op.WRITE -> writeDisk(e.path, e.previousContent, allowCreate = false)
                        }
                    } catch (t: Throwable) {
                        log.warn("undo failed for ${e.path}: ${t.message}")
                        ok = false
                    }
                }
            }
        }
        history.remove(turnId)
        return mapOf("ok" to ok, "count" to entries.size)
    }

    // ---------------- snapshots ---------------- //

    fun snapshot(): List<Map<String, Any?>> = pending.values
        .sortedBy { it.createdAt }
        .map { p ->
            mapOf(
                "pendingId" to p.pendingId,
                "turnId" to p.turnId,
                "path" to p.path,
                "op" to p.op.name.lowercase(),
                "createdAt" to p.createdAt,
                "hunks" to p.hunks.map { h ->
                    mapOf(
                        "id" to h.id,
                        "oldStart" to h.oldStart, "oldCount" to h.oldCount,
                        "newStart" to h.newStart, "newCount" to h.newCount,
                        "status" to h.status.name.lowercase(),
                        "changes" to h.changes.map { c -> mapOf("kind" to c.kind, "text" to c.text) },
                    )
                },
            )
        }

    fun listForTurn(turnId: String): List<Pending> =
        pending.values.filter { it.turnId == turnId }

    // ---------------- helpers ---------------- //

    private fun commit(p: Pending, targetContent: String): Map<String, Any?> {
        try {
            ApplicationManager.getApplication().invokeAndWait {
                WriteCommandAction.runWriteCommandAction(project) {
                    if (p.op == Op.DELETE) {
                        deleteDisk(p.path)
                    } else {
                        writeDisk(p.path, targetContent, allowCreate = true)
                    }
                }
            }
            val committed = if (p.op == Op.DELETE) "" else targetContent
            history.computeIfAbsent(p.turnId) { mutableListOf() }
                .add(
                    HistoryEntry(
                        pendingId = p.pendingId,
                        turnId = p.turnId,
                        path = p.path,
                        op = p.op,
                        previousContent = p.oldContent,
                        committedContent = committed,
                    ),
                )
            pending.remove(p.pendingId)
            broadcastPending()
            emitApplyResult(p, "applied", null)
            return mapOf("ok" to true, "pendingId" to p.pendingId, "path" to p.path)
        } catch (t: ToolViolation) {
            emitApplyResult(p, "error", t.message)
            return mapOf("ok" to false, "error" to (t.message ?: "violation"))
        } catch (t: Throwable) {
            log.warn("commit failed for ${p.path}", t)
            emitApplyResult(p, "error", t.message)
            return mapOf("ok" to false, "error" to (t.message ?: t.javaClass.simpleName))
        }
    }

    private fun readCurrent(path: String): Pair<String, Boolean> {
        return try {
            val vf = PathGuard.resolve(project, path)
            String(vf.contentsToByteArray(), StandardCharsets.UTF_8) to true
        } catch (_: ToolViolation) {
            "" to false
        } catch (_: Throwable) {
            "" to false
        }
    }

    private fun writeDisk(path: String, content: String, allowCreate: Boolean) {
        val target = PathGuard.resolveOrCreate(project, path)
        if (!allowCreate && !Files.exists(target)) {
            throw ToolViolation("file vanished before commit: $path")
        }
        Files.createDirectories(target.parent)
        Files.writeString(target, content)
        LocalFileSystem.getInstance().refreshAndFindFileByPath(target.toString())
    }

    private fun deleteDisk(path: String) {
        val target = PathGuard.resolveOrCreate(project, path)
        if (Files.exists(target)) Files.delete(target)
        LocalFileSystem.getInstance().refreshAndFindFileByIoFile(target.toFile())
    }

    private fun broadcastPending() {
        try {
            bus.emit(
                turnId = "system",
                stepId = "pending",
                type = EventTypes.PENDING_UPDATE,
                payload = mapOf("pending" to snapshot()),
            )
        } catch (t: Throwable) {
            log.warn("broadcast pending.update failed", t)
        }
    }

    private fun emitApplyResult(p: Pending, status: String, error: String?) {
        try {
            bus.emit(
                turnId = p.turnId,
                stepId = p.pendingId,
                type = EventTypes.APPLY_RESULT,
                payload = mapOf(
                    "pendingId" to p.pendingId,
                    "path" to p.path,
                    "status" to status,
                    "error" to error,
                ),
            )
        } catch (t: Throwable) {
            log.warn("broadcast apply.result failed", t)
        }
    }

    companion object {
        fun getInstance(project: Project): PatchStaging = project.service()
    }
}
