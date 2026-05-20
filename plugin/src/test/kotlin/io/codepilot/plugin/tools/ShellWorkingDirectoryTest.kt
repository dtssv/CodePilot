package io.codepilot.plugin.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ShellWorkingDirectoryTest {
    @Test
    fun resolvesDotToAbsoluteBase() {
        val base = File(System.getProperty("java.io.tmpdir"), "codepilot-shell-test").absolutePath
        File(base).mkdirs()
        val resolved = ShellWorkingDirectory.resolve(base, ".")
        assertEquals(File(base).absolutePath, resolved)
    }

    @Test
    fun resolvesRelativeAgainstBase() {
        val base = File(System.getProperty("java.io.tmpdir"), "codepilot-shell-test").absolutePath
        assertEquals(File(base, "build").absolutePath, ShellWorkingDirectory.resolve(base, "build"))
    }

    @Test
    fun isSuccessRequiresZeroExit() {
        assertTrue(ShellWorkingDirectory.isSuccess(mapOf("exitCode" to 0, "timedOut" to false)))
        assertFalse(ShellWorkingDirectory.isSuccess(mapOf("exitCode" to 1, "timedOut" to false)))
        assertFalse(ShellWorkingDirectory.isSuccess(mapOf("exitCode" to 0, "timedOut" to true)))
    }
}
