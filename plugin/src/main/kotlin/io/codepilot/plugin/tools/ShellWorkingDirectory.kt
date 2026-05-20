package io.codepilot.plugin.tools

import com.intellij.openapi.project.Project
import java.io.File

/** Resolves shell {@code cwd} against the IDE project root (never JVM {@code user.dir} via "."). */
object ShellWorkingDirectory {
    fun resolve(project: Project, rawCwd: String?): String = resolve(project.basePath, rawCwd)

    fun resolve(projectBasePath: String?, rawCwd: String?): String {
        val base =
            projectBasePath?.let { File(it).absolutePath }
                ?: System.getProperty("user.dir")
        val trimmed = rawCwd?.trim().orEmpty()
        if (trimmed.isEmpty() || trimmed == "." || trimmed == "./") {
            return base
        }
        val file = File(trimmed)
        return if (file.isAbsolute) file.absolutePath else File(base, trimmed).absolutePath
    }

    /** Shell tool succeeded when exit code is 0 and the process did not time out. */
    fun isSuccess(result: Any?): Boolean {
        val map = result as? Map<*, *> ?: return false
        if (map["timedOut"] == true) return false
        val exitCode =
            when (val code = map["exitCode"]) {
                is Number -> code.toInt()
                else -> -1
            }
        return exitCode == 0
    }
}
