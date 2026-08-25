package io.codepilot.adapter

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.harness.tool.WorkspaceScope
import java.nio.file.Path

/**
 * Bridges the IntelliJ [Project] to the harness-core [WorkspaceScope].
 *
 * The workspace root is derived from the project's base directory
 * (`.guessProjectDir()`), falling back to the current working directory if
 * the project has no base dir yet (e.g. during import).
 *
 * harness-core never touches the IntelliJ API; it only sees the resolved
 * [WorkspaceScope.root] Path. All VFS refresh / canonicalization happens here.
 */
class IntelliJWorkspaceScope(project: Project) {
    val scope: WorkspaceScope = run {
        val baseDir = project.guessProjectDir()?.let { vDir ->
            vDir.toNioPath()
        } ?: Path.of(System.getProperty("user.dir"))

        // Force VFS refresh so freshly created files are visible.
        LocalFileSystem.getInstance().refreshAndFindFileByPath(baseDir.toString())

        WorkspaceScope(baseDir)
    }
}
