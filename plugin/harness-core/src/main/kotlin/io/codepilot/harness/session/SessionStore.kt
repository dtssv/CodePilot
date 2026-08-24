package io.codepilot.harness.session

import io.codepilot.harness.event.HarnessEvent
import kotlinx.serialization.json.Json
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText

class SessionStore(private val eventsFile: Path, private var nextSeq: Long = 0) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false; classDiscriminator = "t" }

    init {
        Files.createDirectories(eventsFile.parent)
        if (Files.exists(eventsFile)) {
            nextSeq = readAll().maxOfOrNull { it.seq }?.plus(1) ?: 0
        }
    }

    @Synchronized
    fun append(event: HarnessEvent): HarnessEvent {
        if (event.seq >= 0) throw IllegalArgumentException("append must not carry a preset seq")
        val withSeq = withSeq(event, nextSeq++)
        RandomAccessFile(eventsFile.toFile(), "rw").use { raf ->
            raf.seek(raf.length())
            val line = json.encodeToString(HarnessEvent.serializer(), withSeq)
            raf.write((line + "\n").toByteArray(Charsets.UTF_8))
            raf.fd.sync()
        }
        return withSeq
    }

    @Synchronized
    fun readAll(): List<HarnessEvent> {
        if (!Files.exists(eventsFile)) return emptyList()
        return eventsFile.readText().lineSequence()
            .filter { it.isNotBlank() }
            .map { line -> json.decodeFromString(HarnessEvent.serializer(), line) }
            .toList()
    }

    /** Replay prefix strictly below seq; used for rewind/fork. */
    fun truncateAfter(seqExclusive: Long): List<HarnessEvent> {
        val all = readAll()
        val kept = all.filter { it.seq < seqExclusive }
        Files.writeString(eventsFile, kept.joinToString("\n") { json.encodeToString(HarnessEvent.serializer(), it) } + if (kept.isEmpty()) "" else "\n")
        nextSeq = kept.maxOfOrNull { it.seq }?.plus(1) ?: 0
        return all.filter { it.seq >= seqExclusive }
    }

    private fun withSeq(event: HarnessEvent, seq: Long): HarnessEvent = when (event) {
        is io.codepilot.harness.event.RunStarted -> event.copy(seq = seq)
        is io.codepilot.harness.event.UserMessageAdded -> event.copy(seq = seq)
        is io.codepilot.harness.event.AssistantMessageAdded -> event.copy(seq = seq)
        is io.codepilot.harness.event.ToolResultAdded -> event.copy(seq = seq)
        is io.codepilot.harness.event.PermissionDecisionRecorded -> event.copy(seq = seq)
        is io.codepilot.harness.event.CompactionApplied -> event.copy(seq = seq)
        is io.codepilot.harness.event.RunFinished -> event.copy(seq = seq)
    }
}
