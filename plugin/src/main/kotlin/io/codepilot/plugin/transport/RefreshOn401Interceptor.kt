package io.codepilot.plugin.transport

import io.codepilot.plugin.auth.AuthService
import io.codepilot.plugin.settings.CodePilotSettings
import okhttp3.Interceptor
import okhttp3.Response
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tries a single token refresh when a request comes back 401, then replays the original request.
 *
 * Locks refreshes across concurrent requests via an AtomicBoolean — only the first failing call
 * drives the refresh; the others wait briefly and re-use the new token.
 *
 * If refresh also fails (e.g. refresh token expired), clears all stored tokens and
 * notifies the WebUI to show the login page.
 *
 * ★ HMAC signature errors (Missing signature headers, Invalid signature, Replay detected)
 * are NOT caused by expired JWTs — refreshing the token won't help. For these errors,
 * we clear tokens and force re-login immediately.
 */
class RefreshOn401Interceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.proceed(chain.request())
        if (original.code != 401) return original

        // Avoid refresh storms if the refresh endpoint itself 401s.
        if (chain
                .request()
                .url.encodedPath
                .endsWith("/v1/auth/refresh")
        ) {
            return original
        }

        // ★ HMAC signature errors are not fixable by token refresh — clear and force re-login.
        // These errors indicate that deviceSecret is missing or mismatched (e.g. cross-IDE
        // session sharing where deviceSecret is not available in the current IDE's PasswordSafe).
        val errorBody = runCatching { original.body?.string()?.take(500) }.getOrNull().orEmpty()
        if (errorBody.contains("Missing signature headers", ignoreCase = true) ||
            errorBody.contains("Invalid signature", ignoreCase = true) ||
            errorBody.contains("Replay detected", ignoreCase = true)
        ) {
            com.intellij.openapi.diagnostic.Logger.getInstance("RefreshOn401Interceptor").warn(
                "[Auth] 401 due to HMAC signature issue (not JWT expiry), clearing tokens and forcing re-login. Error: $errorBody",
            )
            clearTokensAndNotifyLogout()
            return original
        }

        synchronized(LOCK) {
            if (!refreshing.compareAndSet(false, true)) {
                // Another thread is refreshing; just replay with whatever the latest token is.
                return replay(chain, original)
            }
            try {
                val success = runCatching { AuthService.getInstance().refresh().get() }.getOrNull() == true
                if (!success) {
                    // Refresh failed — clear tokens and notify WebUI to show login page
                    clearTokensAndNotifyLogout()
                    return original
                }
            } finally {
                refreshing.set(false)
            }
            return replay(chain, original)
        }
    }

    private fun replay(
        chain: Interceptor.Chain,
        previous: Response,
    ): Response {
        previous.close()
        return chain.proceed(chain.request())
    }

    /** Clear all stored tokens and dispatch auth_state=false to the WebUI. */
    private fun clearTokensAndNotifyLogout() {
        val settings = CodePilotSettings.getInstance()
        settings.setAccessToken(null)
        settings.setRefreshToken(null)
        settings.setDeviceSecret(null)
        // Dispatch to WebUI via the CefChatPanel singleton if available
        notifyLogout()
    }

    companion object {
        private val LOCK = Any()
        private val refreshing = AtomicBoolean(false)

        /** Optional callback set by CefChatPanel to dispatch logout to WebUI. */
        @Volatile
        var onLogout: (() -> Unit)? = null

        fun notifyLogout() {
            onLogout?.invoke()
        }
    }
}
