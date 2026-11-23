package com.codepilot.idea

import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Launch `codepilot serve --daemon` so it is not a long-lived child of the IDE.
 *
 * Direct [ProcessBuilder.start] keeps the daemon's PPID as the IDEA process and
 * triggers "background processes still running" on quit. Mirror the Node
 * `spawnOrphanDaemon` helper: Unix `/bin/sh -c '… &'`, Windows `cmd /c start /b`.
 */
object OrphanDaemon {
    fun shellQuoteUnix(s: String): String =
        "'" + s.replace("'", "'\\''") + "'"

    fun shellQuoteWin(s: String): String {
        if (s.isEmpty()) return "\"\""
        if (!Regex("""[\s"&<>|^()%!]""").containsMatchIn(s)) return s
        return "\"" + s.replace("\"", "\"\"") + "\""
    }

    fun isWindows(osName: String = System.getProperty("os.name", "")): Boolean =
        osName.lowercase().contains("win")

    /** Build launcher argv for tests and [spawn]. */
    fun buildLaunch(
        command: List<String>,
        windows: Boolean = isWindows(),
        comSpec: String = System.getenv("ComSpec") ?: "cmd.exe",
    ): List<String> {
        require(command.isNotEmpty()) { "daemon command must not be empty" }
        return if (windows) {
            val line = command.joinToString(" ") { shellQuoteWin(it) }
            listOf(comSpec, "/d", "/s", "/c", "start \"\" /b $line")
        } else {
            val line = command.joinToString(" ") { shellQuoteUnix(it) }
            listOf("/bin/sh", "-c", "$line >/dev/null 2>&1 &")
        }
    }

    /**
     * Start the orphan launcher and wait briefly for the shell/cmd to exit.
     * Does not return a handle to the daemon — discover via serve.json.
     */
    fun spawn(
        command: List<String>,
        workingDir: String,
        env: Map<String, String>,
    ) {
        val launch = buildLaunch(command)
        val pb = ProcessBuilder(launch).directory(File(workingDir))
        pb.environment().putAll(env)
        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD)
        pb.redirectError(ProcessBuilder.Redirect.DISCARD)
        val p = try {
            pb.start()
        } catch (e: Exception) {
            throw IllegalStateException(
                "could not start `${command.firstOrNull()}`: ${e.message}",
                e,
            )
        }
        // Shell exits immediately after backgrounding; don't keep it as our child.
        p.waitFor(2, TimeUnit.SECONDS)
    }
}
