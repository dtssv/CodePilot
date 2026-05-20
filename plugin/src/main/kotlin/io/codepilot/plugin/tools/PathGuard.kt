package io.codepilot.plugin.tools

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path

/**
 * Ensures every path used by a tool is inside the workspace root and does not escape via `..` or
 * absolute paths outside the project.
 *
 * Read tools (fs.read / fs.list) must be able to inspect build output trees (build/, target/,
 * out/, dist/, cmake-build-*, etc.) — those are not blocked here.
 */
object PathGuard {

    /**
     * Only paths that are never needed for normal agent work and are unsafe or prohibitively large
     * to traverse. Build artifact directories are intentionally allowed.
     */
    private val DENY_DIRS = listOf(".git/objects", "node_modules")

    fun resolve(
        project: Project,
        rawPath: String,
        rootOverride: Path? = null,
    ): VirtualFile {
        val root = rootOverride?.let { workspaceRoot(it) } ?: projectRoot(project)
        val normalized = Path.of(rawPath).normalize()
        val candidate =
            if (normalized.isAbsolute) {
                normalized
            } else {
                Path.of(root.path).resolve(normalized).normalize()
            }
        if (!candidate.startsWith(Path.of(root.path))) {
            throw ToolViolation("path escapes workspace: $rawPath")
        }
        val str = candidate.toString()
        DENY_DIRS.forEach {
            if (str.contains("/$it/") || str.endsWith("/$it") || str.contains("\\$it\\") || str.endsWith("\\$it")) {
                throw ToolViolation("path under denied directory: $rawPath")
            }
        }
        return LocalFileSystem.getInstance().refreshAndFindFileByPath(str)
            ?: throw ToolViolation("file does not exist: $rawPath")
    }

    fun resolveOrCreate(
        project: Project,
        rawPath: String,
        rootOverride: Path? = null,
    ): Path {
        val root = rootOverride?.let { workspaceRoot(it) } ?: projectRoot(project)
        val normalized = Path.of(rawPath).normalize()
        val target =
            if (normalized.isAbsolute) {
                normalized
            } else {
                Path.of(root.path).resolve(normalized).normalize()
            }
        if (!target.startsWith(Path.of(root.path))) {
            throw ToolViolation("path escapes workspace: $rawPath")
        }
        return target
    }

    fun projectRoot(project: Project): VirtualFile {
        val base = project.basePath ?: throw ToolViolation("no project base path")
        return LocalFileSystem.getInstance().refreshAndFindFileByPath(base)
            ?: throw ToolViolation("project root unavailable")
    }

    fun workspaceRoot(rootPath: Path): VirtualFile =
        LocalFileSystem.getInstance().refreshAndFindFileByPath(rootPath.toString())
            ?: throw ToolViolation("workspace root unavailable: $rootPath")
}

class ToolViolation(
    message: String,
) : RuntimeException(message)
