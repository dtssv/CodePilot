package io.codepilot.plugin.transport

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.codepilot.plugin.settings.CodePilotSettings
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Singleton HTTP client. Responsibilities:
 * - signs every protected request (Authorization + HMAC headers)
 * - exposes both regular JSON calls and SSE subscriptions
 * - centralizes retry/circuit-break for cluster-side outages (left simple in M5)
 */
@Service(Service.Level.APP)
class HttpClientService {

    val mapper: ObjectMapper = jacksonObjectMapper()

    private val baseClient: OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .readTimeout(Duration.ofMinutes(10)) // SSE streams may be long
            .writeTimeout(Duration.ofSeconds(30))
            .pingInterval(20, TimeUnit.SECONDS)
            .addInterceptor(::traceHeader)
            .addInterceptor(::authAndSignature)
            .build()

    fun client(): OkHttpClient = baseClient

    /** Builds an authenticated POST request with a JSON body. */
    fun postJson(path: String, body: Any): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        val payload = mapper.writeValueAsBytes(body)
        val rb: RequestBody = payload.toRequestBody("application/json".toMediaType())
        return Request.Builder().url(url).post(rb).header("Accept", "application/json").build()
    }

    /** Same as [postJson] but the response is expected to be Server-Sent Events. */
    fun openSse(request: Request, listener: EventSourceListener): EventSource {
        val sseClient = baseClient.newBuilder().readTimeout(Duration.ZERO).build()
        return EventSources.createFactory(sseClient).newEventSource(request, listener)
    }

    /** Parse a JSON response body into the given type. */
    fun <T> parse(response: Response, type: Class<T>): T = mapper.readValue(response.body!!.bytes(), type)

    private fun traceHeader(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val withTrace =
            if (req.header("X-CodePilot-Trace-Id") != null) req
            else req.newBuilder().header("X-CodePilot-Trace-Id", UUID.randomUUID().toString()).build()
        return chain.proceed(withTrace)
    }

    /**
     * Adds the authentication & signature triplet to outbound requests targeting our backend.
     * Skipped for cross-origin URLs (e.g. third-party Skill registries — they use their own auth).
     */
    private fun authAndSignature(chain: Interceptor.Chain): Response {
        val settings = CodePilotSettings.getInstance()
        val baseHost = runCatching { settings.state.backendBaseUrl.toHttpUrl().host }.getOrNull()
        val req = chain.request()
        if (baseHost != null && req.url.host != baseHost) return chain.proceed(req)

        val builder = req.newBuilder()
        settings.accessToken()?.let { builder.header("Authorization", "Bearer $it") }
        builder.header("X-CodePilot-Device-Id", settings.state.deviceId)

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
        return chain.proceed(builder.build())
    }

    private fun readBody(req: Request): String {
        val body = req.body ?: return ""
        return okio.Buffer().also(body::writeTo).readUtf8()
    }

    companion object {
        @JvmStatic fun getInstance(): HttpClientService = service()
    }
}