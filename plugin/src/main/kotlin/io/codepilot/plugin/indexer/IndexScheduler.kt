package io.codepilot.plugin.indexer

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFileManager
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Orchestrates background codebase indexing — **purely local, no backend**.
 *
 * Architecture decision: Index stays 100% client-side because:
 * - Code already exists locally, no point uploading to re-download
 * - IDEA PSI is the best code understanding engine available
 * - "Backend does not persist user code" is a core design principle
 * - Network latency makes remote search unusable for real-time @codebase
 *
 * Lifecycle:
 * 1. On project open → full scan (if stale > 24h or first time)
 * 2. Periodic incremental sync every 5s (drain VFS change queue)
 * 3. Chunks fed to LocalSearchEngine for in-memory inverted index
 */
@Service(Service.Level.PROJECT)
class IndexScheduler(private val project: Project) : Disposable {

    private val log = Logger.getInstance(IndexScheduler::class.java)

    private val indexStore = LocalIndexStore(project)
    private val chunkBuilder = ChunkBuilder(project)
    private val watcher = IndexWatcher.getInstance(project)
    val searchEngine = LocalSearchEngine(project)

    private val executor: ScheduledExecutorService = Executors.newScheduledThreadPool(2) { r ->
        Thread(r, "CodePilot-Indexer").also { it.isDaemon = true; it.priority = Thread.MIN_PRIORITY }
    }

    private val running = AtomicBoolean(false)
    private val fullScanInProgress = AtomicBoolean(false)
    private val indexedFileCount = AtomicInteger(0)
    private val totalFilesToIndex = AtomicInteger(0)

    /** Current indexing progress (0.0 to 1.0). Used by status bar widget. */
    val progress: Float
        get() {
            val total = totalFilesToIndex.get()
            if (total <= 0) return 1.0f
            return (indexedFileCount.get().toFloat() / total).coerceIn(0f, 1f)
        }

    val isIndexing: Boolean get() = fullScanInProgress.get()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        watcher.initialize()

        // Schedule incremental sync every 5 seconds
        executor.scheduleWithFixedDelay(::incrementalSync, 5, 5, TimeUnit.SECONDS)

        // Check if full scan is needed
        executor.submit {
            val stats = indexStore.stats()
            val staleThreshold = System.currentTimeMillis() - 24 * 3600 * 1000L
            if (stats.lastFullScanMs < staleThreshold || stats.totalFiles == 0) {
                fullScan()
            }
        }

        log.info("IndexScheduler started (local-only) for project: ${project.name}")
    }

    /** Trigger a full re-index of the entire project. */
    fun triggerFullScan() {
        if (!running.get()) return
        executor.submit { fullScan() }
    }

    /** Search the local index. Delegates to LocalSearchEngine. */
    fun search(query: String, topK: Int = 20, language: String? = null): List<LocalSearchEngine.SearchHit> {
        return searchEngine.search(query, topK, language)
    }

    // ─── Internal ───────────────────────────────────────────────────

    private fun fullScan() {
        if (!fullScanInProgress.compareAndSet(false, true)) return
        log.info("Starting full local codebase index for: ${project.name}")

        try {
            val files = ReadAction.compute<List<com.intellij.openapi.vfs.VirtualFile>, Throwable> {
                watcher.collectAllFiles()
            }
            totalFilesToIndex.set(files.size)
            indexedFileCount.set(0)

            val batchSize = 50
            var totalChunks = 0

            for (batch in files.chunked(batchSize)) {
                if (!running.get()) break

                val allChunks = mutableListOf<ChunkBuilder.Chunk>()

                for (vf in batch) {
                    try {
                        val raw = ReadAction.compute<ByteArray?, Throwable> {
                            try { vf.contentsToByteArray() } catch (_: Exception) { null }
                        } ?: continue

                        val fileHash = ChunkBuilder.sha256Hex(raw)
                        val relativePath = vf.path.removePrefix(project.basePath ?: "").trimStart('/')

                        if (!indexStore.needsReindex(relativePath, fileHash)) {
                            indexedFileCount.incrementAndGet()
                            continue
                        }

                        val chunks = ReadAction.compute<List<ChunkBuilder.Chunk>, Throwable> {
                            chunkBuilder.buildChunks(vf)
                        }

                        if (chunks.isNotEmpty()) {
                            allChunks.addAll(chunks)
                            val symbols = chunks.flatMap { it.symbols }.distinct()
                            indexStore.updateEntry(relativePath, fileHash, chunks.size, symbols)
                        }
                        indexedFileCount.incrementAndGet()
                    } catch (e: Exception) {
                        log.debug("Failed to index file: ${vf.path}", e)
                        indexedFileCount.incrementAndGet()
                    }
                }

                // Feed chunks to local search engine
                if (allChunks.isNotEmpty()) {
                    searchEngine.indexChunks(allChunks)
                    totalChunks += allChunks.size
                }

                // Yield to avoid blocking IDE
                Thread.sleep(50)
            }

            indexStore.markFullScanCompleted(files.size, totalChunks)
            indexStore.save()
            val stats = searchEngine.stats()
            log.info("Full scan done: ${files.size} files, $totalChunks chunks, ${stats.totalTerms} terms indexed")
        } catch (e: Exception) {
            log.warn("Full scan failed", e)
        } finally {
            fullScanInProgress.set(false)
        }
    }

    private fun incrementalSync() {
        if (fullScanInProgress.get()) return
        if (!running.get()) return

        val changes = watcher.drainChanges()
        if (changes.isEmpty()) return

        val chunksToIndex = mutableListOf<ChunkBuilder.Chunk>()

        for (change in changes) {
            when (change.kind) {
                IndexWatcher.ChangeKind.DELETED -> {
                    indexStore.removeEntry(change.path)
                    searchEngine.removeFile(change.path)
                }
                IndexWatcher.ChangeKind.CREATED, IndexWatcher.ChangeKind.MODIFIED -> {
                    val vf = VirtualFileManager.getInstance()
                        .findFileByUrl("file://${project.basePath}/${change.path}") ?: continue
                    try {
                        val raw = ReadAction.compute<ByteArray?, Throwable> {
                            try { vf.contentsToByteArray() } catch (_: Exception) { null }
                        } ?: continue
                        val fileHash = ChunkBuilder.sha256Hex(raw)

                        if (indexStore.needsReindex(change.path, fileHash)) {
                            // Remove old entries first
                            searchEngine.removeFile(change.path)

                            val chunks = ReadAction.compute<List<ChunkBuilder.Chunk>, Throwable> {
                                chunkBuilder.buildChunks(vf)
                            }
                            if (chunks.isNotEmpty()) {
                                chunksToIndex.addAll(chunks)
                                val symbols = chunks.flatMap { it.symbols }.distinct()
                                indexStore.updateEntry(change.path, fileHash, chunks.size, symbols)
                            }
                        }
                    } catch (e: Exception) {
                        log.debug("Incremental index failed for: ${change.path}", e)
                    }
                }
                IndexWatcher.ChangeKind.MOVED -> { /* handled as DELETE + CREATE */ }
            }
        }

        if (chunksToIndex.isNotEmpty()) {
            searchEngine.indexChunks(chunksToIndex)
        }
        indexStore.save()
    }

    override fun dispose() {
        running.set(false)
        executor.shutdownNow()
        indexStore.save()
        searchEngine.clear()
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): IndexScheduler = project.service()
    }
}