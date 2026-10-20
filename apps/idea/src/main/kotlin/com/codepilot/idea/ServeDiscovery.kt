package com.codepilot.idea

import com.google.gson.Gson
import java.io.File
import java.nio.file.Files

/** Contents of `~/.codepilot/serve.json` / `server.json`. */
data class ServeInfo(
    val url: String,
    val token: String = "",
    val pid: Int = 0,
    val host: String = "127.0.0.1",
    val port: Int = 0,
    val startedAt: String = "",
    val version: String? = null,
)

/**
 * Read the shared-daemon lockfile when it describes a live loopback server.
 * Returns null when missing, stale, or non-loopback.
 */
object ServeDiscovery {
    private val gson = Gson()

    fun codepilotDir(): File = File(System.getProperty("user.home"), ".codepilot")

    fun lockFiles(): List<File> = listOf(
        File(codepilotDir(), "serve.json"),
        File(codepilotDir(), "server.json"),
    )

    fun readLive(): ServeInfo? {
        for (file in lockFiles()) {
            if (!file.isFile) continue
            val info = runCatching {
                gson.fromJson(file.readText(), ServeInfo::class.java)
            }.getOrNull() ?: continue
            if (info.url.isBlank() || info.pid <= 0) continue
            val loopback = info.host == "127.0.0.1" || info.host == "localhost" || info.host == "::1"
            if (!loopback) continue
            if (!pidAlive(info.pid)) {
                clearStale()
                return null
            }
            return info
        }
        return null
    }

    fun waitLive(timeoutMs: Long = 15_000, intervalMs: Long = 100): ServeInfo? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            readLive()?.let { return it }
            Thread.sleep(intervalMs)
        }
        return readLive()
    }

    fun wsUrl(info: ServeInfo): String {
        val base = info.url.trimEnd('/')
        if (info.token.isBlank()) return base
        val sep = if (base.contains("?")) "&" else "?"
        return "$base${sep}token=${java.net.URLEncoder.encode(info.token, Charsets.UTF_8)}"
    }

    private fun pidAlive(pid: Int): Boolean =
        try {
            // Best-effort: on Unix, kill(pid, 0); on Windows, ProcessHandle.
            ProcessHandle.of(pid.toLong()).map { it.isAlive }.orElse(false)
        } catch (_: Exception) {
            false
        }

    private fun clearStale() {
        for (f in lockFiles()) {
            runCatching { Files.deleteIfExists(f.toPath()) }
        }
    }
}
