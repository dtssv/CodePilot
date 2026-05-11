package io.codepilot.plugin.transport

import io.codepilot.plugin.auth.AuthService
import okhttp3.Interceptor
import okhttp3.Response
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tries a single token refresh when a request comes back 401, then replays the original request.
 *
 * Locks refreshes across concurrent requests via an AtomicBoolean — only the first failing call
 * drives the refresh; the others wait briefly and re-use the new token.
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

        synchronized(LOCK) {
            if (!refreshing.compareAndSet(false, true)) {
                // Another thread is refreshing; just replay with whatever the latest token is.
                return replay(chain, original)
            }
            try {
                val success = runCatching { AuthService.getInstance().refresh().get() }.getOrNull() == true
                if (!success) return original
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

    companion object {
        private val LOCK = Any()
        private val refreshing = AtomicBoolean(false)
    }
}
