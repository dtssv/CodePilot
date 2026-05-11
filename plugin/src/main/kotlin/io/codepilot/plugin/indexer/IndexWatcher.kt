package io.codepilot.plugin.indexer

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.*
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.*
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Watches VFS events in the project and queues changed files for re-indexing.
 *
 * Design:
 * - Listens to BulkFileListener for create/change/delete/move/rename events
 * - Filters out excluded directories (.git, node_modules, build, .idea, etc.)
 * - Accumulates changed file paths in a thread-safe queue
 * - IndexScheduler periodically drains the queue and processes changes
 *
 * This is a project-level service — one instance per open IDEA project.
 */
@Service(Service.Level.PROJECT)
class IndexWatcher(private val project: Project) : Disposable {

    private val log = Logger.getInstance(IndexWatcher::class.java)
    private val pendingChanges = ConcurrentLinkedQueue<FileChange>()
    private val initialized = AtomicBoolean(false)

    /** Directories that should never be indexed. */
    private val excludedDirs = setOf(
        ".git", ".svn", ".hg", ".idea", ".gradle", ".kotlin",
        "node_modules", "build", "dist", "out", "target", ".next",
        "__pycache__", ".mypy_cache", ".pytest_cache", "venv", ".venv",
        ".codePilot", ".intellijPlatform",
    )

    /** File extensions to skip (binary / generated). */
    private val excludedExtensions = setOf(
        "class", "jar", "war", "ear", "zip", "tar", "gz", "7z", "rar",
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp",
        "mp3", "mp4", "avi", "mov", "wav", "flac",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "exe", "dll", "so", "dylib", "o", "a",
        "woff", "woff2", "ttf", "eot", "otf",
        "lock", "min.js", "min.css",
    )

    data class FileChange(
        val path: String,
        val kind: ChangeKind,
    )

    enum class ChangeKind { CREATED, MODIFIED, DELETED, MOVED }

    fun initialize() {
        if (!initialized.compareAndSet(false, true)) return

        project.messageBus.connect(this).subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: MutableList<out VFileEvent>) {
                    for (event in events) {
                        processEvent(event)
                    }
                }
            }
        )
        log.info("IndexWatcher initialized for project: ${project.name}")
    }

    /** Drain all pending changes since last call. Thread-safe. */
    fun drainChanges(): List<FileChange> {
        val changes = mutableListOf<FileChange>()
        while (true) {
            val change = pendingChanges.poll() ?: break
            changes.add(change)
        }
        // Deduplicate by path, keeping the latest change kind
        return changes.groupBy { it.path }
            .map { (_, entries) -> entries.last() }
    }

    /** Check if a VirtualFile should be indexed. */
    fun shouldIndex(vf: VirtualFile): Boolean {
        if (vf.isDirectory) return false
        if (vf.fileType.isBinary) return false
        if (vf.length > ChunkBuilder.MAX_FILE_SIZE_BYTES) return false

        val extension = vf.extension?.lowercase() ?: ""
        if (extension in excludedExtensions) return false

        // Check if any parent directory is excluded
        var current: VirtualFile? = vf.parent
        while (current != null) {
            if (current.name in excludedDirs) return false
            current = current.parent
        }

        // Must be under project content root
        return try {
            ProjectFileIndex.getInstance(project).isInContent(vf)
        } catch (_: Exception) {
            false
        }
    }

    /** Collect all indexable files in the project (for full scan). */
    fun collectAllFiles(): List<VirtualFile> {
        val files = mutableListOf<VirtualFile>()
        val projectRoot = project.basePath?.let { VirtualFileManager.getInstance().findFileByUrl("file://$it") }
            ?: return emptyList()

        VfsUtilCore.iterateChildrenRecursively(projectRoot, { dir ->
            dir.name !in excludedDirs
        }) { file ->
            if (shouldIndex(file)) {
                files.add(file)
            }
            true
        }
        return files
    }

    private fun processEvent(event: VFileEvent) {
        val vf = event.file ?: return
        val projectBase = project.basePath ?: return
        val filePath = vf.path

        // Only process files under project root
        if (!filePath.startsWith(projectBase)) return

        val relativePath = filePath.removePrefix(projectBase).trimStart('/')

        when (event) {
            is VFileCreateEvent -> {
                if (shouldIndex(vf)) {
                    pendingChanges.add(FileChange(relativePath, ChangeKind.CREATED))
                }
            }
            is VFileContentChangeEvent -> {
                if (shouldIndex(vf)) {
                    pendingChanges.add(FileChange(relativePath, ChangeKind.MODIFIED))
                }
            }
            is VFileDeleteEvent -> {
                pendingChanges.add(FileChange(relativePath, ChangeKind.DELETED))
            }
            is VFileMoveEvent -> {
                val oldPath = event.oldPath.removePrefix(projectBase).trimStart('/')
                pendingChanges.add(FileChange(oldPath, ChangeKind.DELETED))
                if (shouldIndex(vf)) {
                    pendingChanges.add(FileChange(relativePath, ChangeKind.CREATED))
                }
            }
            is VFilePropertyChangeEvent -> {
                if (event.propertyName == VirtualFile.PROP_NAME) {
                    // Rename: treat as delete old + create new
                    val oldName = event.oldValue as? String ?: return
                    val parentPath = vf.parent?.path?.removePrefix(projectBase)?.trimStart('/') ?: ""
                    val oldRelativePath = if (parentPath.isEmpty()) oldName else "$parentPath/$oldName"
                    pendingChanges.add(FileChange(oldRelativePath, ChangeKind.DELETED))
                    if (shouldIndex(vf)) {
                        pendingChanges.add(FileChange(relativePath, ChangeKind.CREATED))
                    }
                }
            }
        }
    }

    override fun dispose() {
        pendingChanges.clear()
        log.info("IndexWatcher disposed for project: ${project.name}")
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): IndexWatcher = project.service()
    }
}