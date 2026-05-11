package io.codepilot.plugin.auth

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import java.time.Instant
import java.util.concurrent.CompletableFuture

/**
 * Mid-level login orchestration used by [LoginDialog]. Exposes:
 *  - [discover]  — which login methods the backend advertises
 *  - [oidcLogin] — the full device-code polling loop
 *  - [bridgeLogin] — single-shot SSO-adapter HMAC bootstrap token
 *  - [devLogin]  — dev-only shortcut with `<dev-token>:<user>:<tenant>:<device>`
 */
@Service(Service.Level.APP)
class LoginService {
    fun discover(): CompletableFuture<AuthService.Methods> =
        AuthService.getInstance().fetchMethods().thenApply { r ->
            r.data ?: AuthService.Methods()
        }

    /** Returns an in-progress flow the UI can poll/cancel. */
    fun startOidc(): OidcFlow {
        val auth = AuthService.getInstance()
        val flow = OidcFlow()
        auth
            .startDeviceFlow()
            .whenComplete { code, error ->
                if (error != null) {
                    flow.failed(error.message ?: "device-code failed")
                    return@whenComplete
                }
                flow.begin(code)
                // Auto-open browser for device flow verification
                openVerificationUri(code)
                scheduleOidcPoll(flow, code)
            }
        return flow
    }

    fun bridgeLogin(ssoToken: String): CompletableFuture<Unit> = AuthService.getInstance().login(ssoToken).thenApply { }

    fun devLogin(
        token: String,
        userId: String,
        tenantId: String,
        deviceId: String,
    ): CompletableFuture<Unit> {
        val packed = "$token:$userId:$tenantId:$deviceId"
        return AuthService.getInstance().login(packed).thenApply { }
    }

    private fun scheduleOidcPoll(
        flow: OidcFlow,
        code: AuthService.DeviceCode,
    ) {
        val pollMillis =
            (code.interval ?: AuthService.DEFAULT_DEVICE_POLL_INTERVAL.seconds) * 1_000L
        val deadline = Instant.now().plusSeconds(code.expiresIn ?: 600L)
        val auth = AuthService.getInstance()
        val loop =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "codepilot-device-poll").apply { isDaemon = true }
            }
        loop.schedule(
            object : Runnable {
                override fun run() {
                    if (flow.isCancelled || Instant.now().isAfter(deadline)) {
                        flow.failed("device authorization timed out")
                        loop.shutdown()
                        return
                    }
                    auth
                        .pollDeviceToken(code.deviceCode)
                        .whenComplete { tok, err ->
                            if (err != null && err.message?.contains("authorization_pending", ignoreCase = true) == true) {
                                loop.schedule(this, pollMillis, java.util.concurrent.TimeUnit.MILLISECONDS)
                                return@whenComplete
                            }
                            if (err != null) {
                                flow.failed(err.message ?: "device-token failed")
                                loop.shutdown()
                                return@whenComplete
                            }
                            val idToken = tok.idToken
                            if (idToken.isNullOrBlank()) {
                                loop.schedule(this, pollMillis, java.util.concurrent.TimeUnit.MILLISECONDS)
                                return@whenComplete
                            }
                            auth
                                .login(idToken)
                                .whenComplete { _, loginErr ->
                                    if (loginErr != null) {
                                        flow.failed(loginErr.message ?: "login failed")
                                    } else {
                                        flow.succeeded()
                                    }
                                    loop.shutdown()
                                }
                        }
                }
            },
            pollMillis,
            java.util.concurrent.TimeUnit.MILLISECONDS,
        )
    }

    /**
     * Opens the device verification URI in the system browser automatically.
     * Falls back silently if the browser cannot be opened.
     */
    private fun openVerificationUri(code: AuthService.DeviceCode) {
        val uri = code.verificationUriComplete ?: code.verificationUri ?: return
        try {
            com.intellij.ide.BrowserUtil
                .browse(uri)
        } catch (e: Exception) {
            // Silent fallback: user can still manually navigate
            com.intellij.openapi.diagnostic.Logger
                .getInstance("LoginService")
                .info("Could not auto-open browser for device flow: ${e.message}")
        }
    }

    /** Small state holder consumed by the Swing dialog. */
    class OidcFlow {
        @Volatile var code: AuthService.DeviceCode? = null
        private val future = CompletableFuture<Unit>()

        @Volatile var isCancelled = false
            private set

        fun begin(code: AuthService.DeviceCode) {
            this.code = code
        }

        fun succeeded() {
            future.complete(Unit)
        }

        fun failed(reason: String) {
            future.completeExceptionally(IllegalStateException(reason))
        }

        fun cancel() {
            isCancelled = true
            future.completeExceptionally(IllegalStateException("cancelled"))
        }

        fun asFuture(): CompletableFuture<Unit> = future
    }

    companion object {
        @JvmStatic fun getInstance(): LoginService = service()
    }
}
