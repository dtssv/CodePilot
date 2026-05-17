package io.codepilot.plugin.memory

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

@Service(Service.Level.PROJECT)
class MemoryService(private val project: Project) {
    data class Memory(
        val id: String,
        val scope: String,
        val kind: String,
        val text: String,
        val confidence: Double = 0.8,
        val status: String = "approved", // suggested | approved | rejected
        val createdAt: Long = System.currentTimeMillis(),
        val updatedAt: Long = System.currentTimeMillis(),
    )

    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val memories = AtomicReference<List<Memory>>(emptyList())

    private val storePath: Path?
        get() = project.basePath?.let { Path.of(it, ".codepilot", "memories.json") }

    fun load(): List<Memory> {
        val p = storePath ?: return emptyList()
        val loaded = if (Files.exists(p)) {
            runCatching { mapper.readValue<List<Memory>>(p.toFile()) }.getOrDefault(emptyList())
        } else emptyList()
        memories.set(loaded)
        emit()
        return loaded
    }

    fun list(status: String? = null): List<Memory> {
        val all = memories.get().ifEmpty { load() }
        return if (status == null) all else all.filter { it.status == status }
    }

    fun renderApproved(): String {
        val approved = list("approved")
        if (approved.isEmpty()) return ""
        return buildString {
            appendLine("## Project Memories (approved)")
            for (m in approved.sortedBy { it.kind }) {
                appendLine("- [${m.kind}] ${m.text}")
            }
        }.trim()
    }

    fun upsert(memory: Memory): Memory {
        val next = memories.get().filterNot { it.id == memory.id } + memory.copy(updatedAt = System.currentTimeMillis())
        memories.set(next)
        save()
        emit()
        return memory
    }

    fun setStatus(id: String, status: String): Boolean {
        var found = false
        val next = memories.get().map {
            if (it.id == id) {
                found = true
                it.copy(status = status, updatedAt = System.currentTimeMillis())
            } else it
        }
        if (found) {
            memories.set(next)
            save()
            emit()
        }
        return found
    }

    fun remove(id: String): Boolean {
        val before = memories.get()
        val next = before.filterNot { it.id == id }
        if (next.size == before.size) return false
        memories.set(next)
        save()
        emit()
        return true
    }

    private fun save() {
        val p = storePath ?: return
        Files.createDirectories(p.parent)
        mapper.writerWithDefaultPrettyPrinter().writeValue(p.toFile(), memories.get())
    }

    private fun emit() {
        EventBus.getInstance(project).emit(
            turnId = "system",
            stepId = "memory",
            type = EventTypes.MEMORY_UPDATE,
            payload = mapOf("memories" to memories.get()),
        )
    }

    companion object {
        fun getInstance(project: Project): MemoryService = project.service()
    }
}
