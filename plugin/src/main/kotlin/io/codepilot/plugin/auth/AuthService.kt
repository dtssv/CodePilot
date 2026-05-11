package io.codepilot.plugin.auth

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.time.Duration
import java.util.concurrent.CompletableFuture

/**
 * High-level entry for authentication. Wraps:
 *  - `GET  /v1/auth/methods`
 *  - `POST /v1/auth/login`
 *  - `POST /v1/auth/refresh`
 *  - `POST /v1/auth/device-code` / `POST /v1/auth/device-token`
 *
 * Tokens are persisted via [CodePilotSettings] (PasswordSafe-backed).
 */
@Service(Service.Level.APP)
class AuthService {
    fun fetchMethods(): CompletableFuture<MethodsResponse> = execute(buildGet("/v1/auth/methods"), MethodsResponse::class.java)

    fun login(ssoToken: String): CompletableFuture<LoginResult> {
        val client = HttpClientService.getInstance()
        val req = client.postJson("/v1/auth/login", mapOf("ssoToken" to ssoToken))
        return execute(req, LoginEnvelope::class.java).thenApply { env ->
            val result = env.data ?: error("login: empty data")
            persist(result)
            result
        }
    }

    fun refresh(): CompletableFuture<Boolean> {
        val settings = CodePilotSettings.getInstance()
        val refreshToken = settings.refreshToken() ?: return CompletableFuture.completedFuture(false)
        val client = HttpClientService.getInstance()
        val req = client.postJson("/v1/auth/refresh", mapOf("refreshToken" to refreshToken))
        return execute(req, RefreshEnvelope::class.java).thenApply { env ->
            val token = env.data?.accessToken ?: return@thenApply false
            settings.setAccessToken(token)
            true
        }
    }

    fun startDeviceFlow(): CompletableFuture<DeviceCode> {
        val client = HttpClientService.getInstance()
        val req = client.postJson("/v1/auth/device-code", emptyMap<String, String>())
        return execute(req, DeviceCodeEnvelope::class.java).thenApply {
            it.data ?: error("device-code: empty data")
        }
    }

    fun pollDeviceToken(deviceCode: String): CompletableFuture<DeviceToken> {
        val client = HttpClientService.getInstance()
        val req = client.postJson("/v1/auth/device-token", mapOf("deviceCode" to deviceCode))
        return execute(req, DeviceTokenEnvelope::class.java).thenApply {
            it.data ?: error("device-token: empty data")
        }
    }

    private fun persist(result: LoginResult) {
        val settings = CodePilotSettings.getInstance()
        settings.setAccessToken(result.accessToken)
        settings.setRefreshToken(result.refreshToken)
        settings.setDeviceSecret(result.deviceSecret)
    }

    private fun buildGet(path: String): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        return Request
            .Builder()
            .url(url)
            .get()
            .header("Accept", "application/json")
            .build()
    }

    private val log =
        com.intellij.openapi.diagnostic
            .logger<AuthService>()

    private fun <T> execute(
        request: Request,
        type: Class<T>,
    ): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        val client = HttpClientService.getInstance()
        log.info("[Auth] HTTP ${request.method} ${request.url}")
        client.client().newCall(request).enqueue(
            object : okhttp3.Callback {
                override fun onFailure(
                    call: okhttp3.Call,
                    e: java.io.IOException,
                ) {
                    log.error("[Auth] HTTP request failed: ${request.method} ${request.url}", e)
                    future.completeExceptionally(e)
                }

                override fun onResponse(
                    call: okhttp3.Call,
                    response: okhttp3.Response,
                ) {
                    log.info("[Auth] HTTP response: ${request.method} ${request.url} -> ${response.code} ${response.message}")
                    response.use {
                        if (!it.isSuccessful) {
                            val errBody = runCatching { it.body?.string()?.take(500) }.getOrNull()
                            log.warn("[Auth] HTTP error body: $errBody")
                            future.completeExceptionally(IllegalStateException("HTTP ${it.code}: $errBody"))
                            return
                        }
                        runCatching { client.parse(it, type) }
                            .onSuccess(future::complete)
                            .onFailure { e ->
                                log.error("[Auth] Parse failed", e)
                                future.completeExceptionally(e)
                            }
                    }
                }
            },
        )
        return future
    }

    // -------------------- DTOs --------------------

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class MethodsResponse(
        val code: Int,
        val message: String?,
        val data: Methods?,
        val traceId: String? = null,
        val ts: String? = null,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Methods(
        val oidc: Boolean = false,
        val hmacBridge: Boolean = false,
        val dev: Boolean = false,
        val deviceFlow: Boolean = false,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class LoginResult(
        @JsonProperty("accessToken") val accessToken: String,
        @JsonProperty("accessExpiresAt") val accessExpiresAt: String?,
        @JsonProperty("refreshToken") val refreshToken: String,
        @JsonProperty("refreshExpiresAt") val refreshExpiresAt: String?,
        @JsonProperty("deviceSecret") val deviceSecret: String,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class LoginEnvelope(
        val code: Int,
        val message: String?,
        val data: LoginResult?,
        val traceId: String? = null,
        val ts: String? = null,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class RefreshResult(
        val accessToken: String,
        val accessExpiresAt: String?,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class RefreshEnvelope(
        val code: Int,
        val message: String?,
        val data: RefreshResult?,
        val traceId: String? = null,
        val ts: String? = null,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class DeviceCode(
        val deviceCode: String,
        val userCode: String?,
        val verificationUri: String?,
        val verificationUriComplete: String?,
        val expiresIn: Long?,
        val interval: Long?,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class DeviceCodeEnvelope(
        val code: Int,
        val message: String?,
        val data: DeviceCode?,
        val traceId: String? = null,
        val ts: String? = null,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class DeviceToken(
        val accessToken: String?,
        val idToken: String?,
        val refreshToken: String?,
        val expiresIn: Long?,
        val tokenType: String?,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class DeviceTokenEnvelope(
        val code: Int,
        val message: String?,
        val data: DeviceToken?,
        val traceId: String? = null,
        val ts: String? = null,
    )

    companion object {
        @JvmStatic fun getInstance(): AuthService = service()

        val DEFAULT_DEVICE_POLL_INTERVAL: Duration = Duration.ofSeconds(5)
    }
}
