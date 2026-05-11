package io.codepilot.plugin.update

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicReference

/**
 * Registry of runtime-hot-swappable resources. Maintains a current and previous
 * version directory; switching is atomic (directory rename).
 *
 * Resources that qualify for hot-patch: webui dist, prompt templates, tool schemas.
 */
@Service(Service.Level.APP)
class RuntimeResourceRegistry {
    private val log = logger<RuntimeResourceRegistry>()
    private val currentDir = AtomicReference<Path>()
    private val previousDir = AtomicReference<Path>()

    /** Initialize from plugin data directory. */
    fun init(baseDir: Path) {
        val current = baseDir.resolve("current")
        val previous = baseDir.resolve("previous")
        Files.createDirectories(current)
        Files.createDirectories(previous)
        currentDir.set(current)
        previousDir.set(previous)
    }

    /** Atomically switch to a new resource directory (the new content is already in [newDir]). */
    fun atomicSwitch(newDir: Path) {
        val base = currentDir.get().parent
        val old = currentDir.get()
        val prev = previousDir.get()

        // Move current → previous (overwrite previous)
        if (Files.exists(prev)) {
            prev.toFile().deleteRecursively()
        }
        Files.move(old, prev, StandardCopyOption.ATOMIC_MOVE)
        previousDir.set(prev)

        // Move new → current
        Files.move(newDir, old, StandardCopyOption.ATOMIC_MOVE)
        currentDir.set(old)

        log.info("Resource registry switched to new version at: $old")
    }

    /** Rollback to the previous version. */
    fun rollback(): Boolean {
        val prev = previousDir.get() ?: return false
        if (!Files.exists(prev) || !Files.isDirectory(prev)) return false
        atomicSwitch(prev)
        log.info("Rolled back to previous version")
        return true
    }

    fun currentPath(): Path = currentDir.get()

    companion object {
        @JvmStatic fun getInstance(): RuntimeResourceRegistry = service()
    }
}
