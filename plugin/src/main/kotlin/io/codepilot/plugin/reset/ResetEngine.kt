package io.codepilot.plugin.reset

import io.codepilot.plugin.settings.CodePilotSettings
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Instant

/**
 * Force-reset engine. Implements two strategies:
 *
 *  - Soft: clear in-memory caches and credentials only.
 *  - Hard: rename the local CodePilot folder so the next start sees a clean state. The IDE is then
 *    asked to restart so the plugin reloads against the freshly-empty folder.
 */
object ResetEngine {
    private fun root(): Path = Path.of(System.getProperty("user.home"), ".codePilot")

    fun softReset() {
        val settings = CodePilotSettings.getInstance()
        settings.setAccessToken(null)
        settings.setRefreshToken(null)
        settings.setDeviceSecret(null)
    }

    /** Renames `~/.codePilot` to `~/.codePilot.broken-<ts>` and writes the clean-start sentinel. */
    fun hardResetAndMarkRestart(): Path {
        val src = root()
        val target =
            src.parent.resolve(".codePilot.broken-" + Instant.now().toEpochMilli())
        if (Files.exists(src)) {
            Files.move(src, target, StandardCopyOption.REPLACE_EXISTING)
        }
        Files.createDirectories(src.resolve("flags"))
        Files.writeString(
            src.resolve("flags").resolve("clean_start"),
            "requestedAt=" + Instant.now() + "\nreason=hard_reset\n",
        )
        return target
    }

    /**
     * Detects an externally-set sentinel created via the shell helper:
     * `touch ~/.codePilot/flags/reset_hard_local`. Returns true when the StartupActivity should
     * apply a hard reset before continuing.
     */
    fun consumeExternalSentinels(): Boolean {
        val flags = root().resolve("flags")
        if (!Files.isDirectory(flags)) return false
        var triggered = false
        listOf("reset_hard_local", "reset_factory").forEach { name ->
            val f = flags.resolve(name)
            if (Files.exists(f)) {
                triggered = true
                Files.deleteIfExists(f)
            }
        }
        if (Files.exists(flags.resolve("reset_soft"))) {
            softReset()
            Files.deleteIfExists(flags.resolve("reset_soft"))
        }
        return triggered
    }
}
