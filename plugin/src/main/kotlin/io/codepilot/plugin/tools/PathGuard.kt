package io.codepilot.plugin.tools

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path

/**
 * Ensures every path used by a tool is *inside the current workspace root* and does not escape
 * via `..`, absolute paths, or sensitive directories (e.g. `.git/objects`, `node_modules`).
 */
object PathGuard {
    private val DENY_DIRS = listOf(".git/objects", ".idea", "node_modules", "target", "build")

    fun resolve(
        project: Project,
        rawPath: String,
    ): VirtualFile {
        val root = projectRoot(project)
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
    ): Path {
        val root = projectRoot(project)
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
}

class ToolViolation(
    message: String,
) : RuntimeException(message)
