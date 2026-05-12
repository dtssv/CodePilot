package io.codepilot.plugin.transport

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.codepilot.plugin.settings.CodePilotSettings
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Singleton HTTP client. Responsibilities:
 * - signs every protected request (Authorization + HMAC headers)
 * - exposes both regular JSON calls and SSE subscriptions
 * - centralizes retry/circuit-break for cluster-side outages (left simple in M5)
 */
@Service(Service.Level.APP)
class HttpClientService {
    val mapper: ObjectMapper =
        jacksonObjectMapper()
            .disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)

    private val baseClient: OkHttpClient =
        OkHttpClient
            .Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofMinutes(10)) // SSE streams may be long
            .writeTimeout(Duration.ofSeconds(30))
            .pingInterval(20, TimeUnit.SECONDS)
            .connectionPool(okhttp3.ConnectionPool(0, 1, TimeUnit.SECONDS)) // No connection reuse
            .retryOnConnectionFailure(true)
            .addInterceptor(::traceHeader)
            .addInterceptor(::authAndSignature)
            .addInterceptor(RefreshOn401Interceptor())
            .build()

    fun client(): OkHttpClient = baseClient

    /** Builds an authenticated GET request. */
    fun get(
        path: String,
    ): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        return Request
            .Builder()
            .url(url)
            .get()
            .header("Accept", "application/json")
            .build()
    }

    /** Builds an authenticated POST request with a JSON body. */
    fun postJson(
        path: String,
        body: Any,
    ): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        val payload = mapper.writeValueAsBytes(body)
        val rb: RequestBody = payload.toRequestBody("application/json; charset=utf-8".toMediaType())
        return Request
            .Builder()
            .url(url)
            .post(rb)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json; charset=utf-8")
            .build()
    }

    /** Builds an authenticated multipart POST request with a file part. */
    fun postMultipart(
        path: String,
        partName: String,
        fileName: String,
        contentType: String,
        data: ByteArray,
    ): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        val fileBody = data.toRequestBody(contentType.toMediaType())
        val multipartBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(partName, fileName, fileBody)
            .build()
        return Request
            .Builder()
            .url(url)
            .post(multipartBody)
            .header("Accept", "application/json")
            .build()
    }

    /** Same as [postJson] but the response is expected to be Server-Sent Events. */
    fun openSse(
        request: Request,
        listener: EventSourceListener,
    ): EventSource {
        val sseClient = baseClient.newBuilder().readTimeout(Duration.ZERO).build()
        return EventSources.createFactory(sseClient).newEventSource(request, listener)
    }

    /** Parse a JSON response body into the given type. */
    fun <T> parse(
        response: Response,
        type: Class<T>,
    ): T = mapper.readValue(response.body!!.bytes(), type)

    private fun traceHeader(chain: Interceptor.Chain): Response {
        val req = chain.request()
        // Reuse session-scoped traceId if present, otherwise generate new
        val existingTrace = req.header("X-CodePilot-Trace-Id")
        if (existingTrace != null) return chain.proceed(req)

        // Extract sessionId from request URL or body to maintain per-session trace continuity
        val sessionTraceId =
            req.url.toString().let { url ->
                sessionTraceCache.values.firstOrNull() ?: UUID.randomUUID().toString()
            }
        val withTrace = req.newBuilder().header("X-CodePilot-Trace-Id", sessionTraceId).build()
        return chain.proceed(withTrace)
    }

    /** Session-scoped trace ID cache: sessionId → traceId. Ensures all requests
     *  within the same conversation session share the same trace ID for correlation. */
    private val sessionTraceCache = ConcurrentHashMap<String, String>()

    /** Set the trace ID for a session. Called when a new conversation starts. */
    fun setSessionTraceId(
        sessionId: String,
        traceId: String = UUID.randomUUID().toString(),
    ) {
        sessionTraceCache[sessionId] = traceId
    }

    /** Get the current trace ID for a session. */
    fun getSessionTraceId(sessionId: String): String? = sessionTraceCache[sessionId]

    /** Clear session trace ID when conversation ends. */
    fun clearSessionTraceId(sessionId: String) {
        sessionTraceCache.remove(sessionId)
    }

    /**
     * Adds the authentication & signature triplet to outbound requests targeting our backend.
     * Skipped for cross-origin URLs (e.g. third-party Skill registries — they use their own auth).
     */
    private fun authAndSignature(chain: Interceptor.Chain): Response {
        val settings = CodePilotSettings.getInstance()
        val baseHost =
            runCatching {
                settings.state.backendBaseUrl
                    .toHttpUrl()
                    .host
            }.getOrNull()
        val req = chain.request()
        if (baseHost != null && req.url.host != baseHost) return chain.proceed(req)

        val builder = req.newBuilder()
        settings.accessToken()?.let { builder.header("Authorization", "Bearer $it") }
        builder.header("X-CodePilot-Device-Id", settings.state.deviceId)

        // Dev token: if set, add as header for gateway to bypass JWT verification
        val devToken = settings.state.devToken
        if (!devToken.isNullOrBlank()) {
            builder.header("X-CodePilot-Dev-Token", devToken)
        }

        val ts = System.currentTimeMillis().toString()
        val nonce = UUID.randomUUID().toString()
        val bodyBytes = readBody(req)
        val secret = settings.deviceSecret()
        if (secret != null) {
            val signature = HmacSigner(secret).sign(bodyBytes, ts, nonce)
            builder
                .header("X-CodePilot-Ts", ts)
                .header("X-CodePilot-Nonce", nonce)
                .header("X-CodePilot-Signature", signature)
        }

        val builtReq = builder.build()
        com.intellij.openapi.diagnostic.Logger.getInstance("HttpClientService").info(
            "[HTTP] ${builtReq.method} ${builtReq.url} | " +
                "auth=${settings.accessToken() != null} devToken=${!devToken.isNullOrBlank()} " +
                "deviceSecret=${secret != null} " +
                "headers=[${builtReq.headers.filter {
                    it.first.startsWith(
                        "X-CodePilot",
                    ) ||
                        it.first == "Authorization" ||
                        it.first == "Connection"
                }.joinToString(", ") { "${it.first}=${it.second.take(30)}" }}]",
        )

        return chain.proceed(builtReq)
    }

    private fun readBody(req: Request): String {
        val body = req.body ?: return ""
        val buffer = okio.Buffer()
        body.writeTo(buffer)
        return buffer.readUtf8()
    }

    companion object {
        @JvmStatic fun getInstance(): HttpClientService = service()
    }
}
