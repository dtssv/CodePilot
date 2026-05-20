package io.codepilot.plugin.shell

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** User decision for a pending shell.exec permission prompt (WebUI → plugin). */
enum class ShellGrantDecision {
    ALLOW,
    DENY,
    SKIP,
}

/**
 * Blocks [ShellExecutor] until the WebUI responds via [complete], or times out.
 * See doc/08-shell-allowlist.md.
 */
object ShellGrantWaiter {
    private val waiters = ConcurrentHashMap<String, CompletableFuture<ShellGrantDecision>>()

    fun awaitGrant(token: String, timeoutMs: Long): ShellGrantDecision? {
        val future = CompletableFuture<ShellGrantDecision>()
        waiters[token] = future
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            null
        } finally {
            waiters.remove(token)
        }
    }

    fun complete(token: String, decision: ShellGrantDecision) {
        waiters.remove(token)?.complete(decision)
    }
}
