package io.codepilot.plugin.indexer

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.io.File
import java.security.MessageDigest

/**
 * Local file-based index metadata store.
 * Tracks per-file hash and chunk count so we can skip unchanged files during incremental sync.
 *
 * Storage: ~/.codePilot/index/<workspaceHash>/index.json
 *
 * This is intentionally simple (JSON file) rather than SQLite to minimize dependencies.
 * For projects with >10k files, consider migrating to SQLite.
 */
class LocalIndexStore(private val project: Project) {

    private val log = Logger.getInstance(LocalIndexStore::class.java)
    private val mapper: ObjectMapper = jacksonObjectMapper()

    data class FileEntry(
        val path: String,
        val contentHash: String,
        val chunkCount: Int,
        val indexedAtMs: Long,
        val symbols: List<String> = emptyList(),
    )

    data class IndexMetadata(
        val workspaceHash: String,
        val projectName: String,
        val lastFullScanMs: Long = 0L,
        val totalFiles: Int = 0,
        val totalChunks: Int = 0,
        val entries: MutableMap<String, FileEntry> = mutableMapOf(),
    )

    val workspaceHash: String by lazy {
        val base = project.basePath ?: "unknown"
        val digest = MessageDigest.getInstance("SHA-256")
        digest.digest(base.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
    }

    private val indexDir: File by lazy {
        val home = System.getProperty("user.home")
        File(home, ".codePilot/index/$workspaceHash").also { it.mkdirs() }
    }

    private val indexFile: File get() = File(indexDir, "index.json")

    @Volatile
    private var metadata: IndexMetadata? = null

    /** Load index metadata from disk. Returns cached version if already loaded. */
    fun load(): IndexMetadata {
        metadata?.let { return it }
        return try {
            if (indexFile.exists()) {
                val loaded = mapper.readValue<IndexMetadata>(indexFile)
                metadata = loaded
                loaded
            } else {
                val fresh = IndexMetadata(
                    workspaceHash = workspaceHash,
                    projectName = project.name,
                )
                metadata = fresh
                fresh
            }
        } catch (e: Exception) {
            log.warn("Failed to load index metadata, starting fresh", e)
            val fresh = IndexMetadata(workspaceHash = workspaceHash, projectName = project.name)
            metadata = fresh
            fresh
        }
    }

    /** Save current metadata to disk. */
    fun save() {
        val meta = metadata ?: return
        try {
            indexDir.mkdirs()
            mapper.writerWithDefaultPrettyPrinter().writeValue(indexFile, meta)
        } catch (e: Exception) {
            log.warn("Failed to save index metadata", e)
        }
    }

    /** Check if a file needs re-indexing based on content hash. */
    fun needsReindex(path: String, currentHash: String): Boolean {
        val meta = load()
        val entry = meta.entries[path] ?: return true
        return entry.contentHash != currentHash
    }

    /** Update the index entry for a file after successful indexing. */
    fun updateEntry(path: String, contentHash: String, chunkCount: Int, symbols: List<String>) {
        val meta = load()
        meta.entries[path] = FileEntry(
            path = path,
            contentHash = contentHash,
            chunkCount = chunkCount,
            indexedAtMs = System.currentTimeMillis(),
            symbols = symbols,
        )
    }

    /** Remove a file entry (e.g., after file deletion). */
    fun removeEntry(path: String) {
        val meta = load()
        meta.entries.remove(path)
    }

    /** Mark a full scan as completed. */
    fun markFullScanCompleted(totalFiles: Int, totalChunks: Int) {
        val meta = load()
        metadata = meta.copy(
            lastFullScanMs = System.currentTimeMillis(),
            totalFiles = totalFiles,
            totalChunks = totalChunks,
        )
    }

    /** Get all known file paths in the index. */
    fun allIndexedPaths(): Set<String> = load().entries.keys.toSet()

    /** Get statistics for status bar display. */
    fun stats(): IndexStats {
        val meta = load()
        return IndexStats(
            totalFiles = meta.entries.size,
            totalChunks = meta.entries.values.sumOf { it.chunkCount },
            lastFullScanMs = meta.lastFullScanMs,
        )
    }

    data class IndexStats(
        val totalFiles: Int,
        val totalChunks: Int,
        val lastFullScanMs: Long,
    )

    /** Clear the entire local index. */
    fun clear() {
        metadata = IndexMetadata(workspaceHash = workspaceHash, projectName = project.name)
        try {
            indexFile.delete()
        } catch (_: Exception) {}
    }

    /** Search local symbol index (fast, no backend call). */
    fun searchSymbols(query: String, limit: Int = 20): List<SymbolHit> {
        val meta = load()
        val queryLower = query.lowercase()
        return meta.entries.values
            .flatMap { entry ->
                entry.symbols
                    .filter { it.lowercase().contains(queryLower) }
                    .map { SymbolHit(entry.path, it) }
            }
            .take(limit)
    }

    data class SymbolHit(val path: String, val symbol: String)
}