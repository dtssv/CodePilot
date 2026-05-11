package io.codepilot.plugin.marketplace

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.readValue
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.util.concurrent.CompletableFuture

/** Thin wrapper around the official marketplace endpoints. */
class MarketplaceClient(
    private val http: HttpClientService = HttpClientService.getInstance(),
) {
    fun listPackages(
        type: String? = null,
        query: String? = null,
        page: Int = 1,
        size: Int = 50,
    ): CompletableFuture<List<Package>> {
        val url =
            base()
                .newBuilder()
                .addPathSegments("v1/mcp/packages")
                .apply {
                    if (type != null) addQueryParameter("type", type)
                    if (!query.isNullOrBlank()) addQueryParameter("q", query)
                    addQueryParameter("page", page.toString())
                    addQueryParameter("size", size.toString())
                }.build()
        return execute(
            Request
                .Builder()
                .url(url)
                .get()
                .build(),
            PageEnvelope::class.java,
        ).thenApply { it.data?.items.orEmpty() }
    }

    fun manifest(
        slug: String,
        version: String,
    ): CompletableFuture<Map<String, Any?>> {
        val url =
            base()
                .newBuilder()
                .addPathSegments("v1/mcp/packages/$slug/versions/$version/manifest")
                .build()
        return executeMap(
            Request
                .Builder()
                .url(url)
                .get()
                .build(),
        )
    }

    fun reportInstall(
        slug: String,
        version: String,
        scope: LocalMarketplaceStore.Scope,
        source: LocalMarketplaceStore.Source,
    ): CompletableFuture<Boolean> {
        val req =
            http.postJson(
                "/v1/mcp/install",
                mapOf("slug" to slug, "version" to version, "scope" to scope.value, "source" to source.value),
            )
        return executeBool(req)
    }

    fun reportUninstall(
        slug: String,
        version: String,
        scope: LocalMarketplaceStore.Scope,
        source: LocalMarketplaceStore.Source,
    ): CompletableFuture<Boolean> {
        val req =
            http.postJson(
                "/v1/mcp/uninstall",
                mapOf("slug" to slug, "version" to version, "scope" to scope.value, "source" to source.value),
            )
        return executeBool(req)
    }

    // ── Skill API ──────────────────────────────────────────────────────

    /** List available Skills from the marketplace. */
    fun listSkills(
        query: String? = null,
        page: Int = 1,
        size: Int = 50,
    ): CompletableFuture<List<Package>> {
        val url =
            base()
                .newBuilder()
                .addPathSegments("v1/skills/packages")
                .apply {
                    if (!query.isNullOrBlank()) addQueryParameter("q", query)
                    addQueryParameter("page", page.toString())
                    addQueryParameter("size", size.toString())
                }.build()
        return execute(
            Request
                .Builder()
                .url(url)
                .get()
                .build(),
            PageEnvelope::class.java,
        ).thenApply { it.data?.items.orEmpty() }
    }

    /** Get Skill manifest (redacted for system Skills). */
    fun skillManifest(
        slug: String,
        version: String,
    ): CompletableFuture<Map<String, Any?>> {
        val url =
            base()
                .newBuilder()
                .addPathSegments("v1/skills/packages/$slug/versions/$version/manifest")
                .build()
        return executeMap(
            Request
                .Builder()
                .url(url)
                .get()
                .build(),
        )
    }

    /**
     * Get download info for a Skill package.
     * Returns: downloadUrl, sha256, signature, signedAtMs.
     * The caller must verify sha256 after downloading.
     */
    fun skillDownload(
        slug: String,
        version: String,
    ): CompletableFuture<DownloadInfo> {
        val url =
            base()
                .newBuilder()
                .addPathSegments("v1/skills/packages/$slug/versions/$version/download")
                .build()
        return execute(
            Request
                .Builder()
                .url(url)
                .get()
                .build(),
            DownloadInfo::class.java,
        )
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class DownloadInfo(
        val url: String,
        val sha256: String,
        val signature: String?,
        val signedAtMs: Long?,
    )

    private fun base() =
        CodePilotSettings
            .getInstance()
            .state.backendBaseUrl
            .trimEnd('/')
            .toHttpUrl()

    private fun <T> execute(
        request: Request,
        type: Class<T>,
    ): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        http.client().newCall(request).enqueue(
            object : okhttp3.Callback {
                override fun onFailure(
                    call: okhttp3.Call,
                    e: java.io.IOException,
                ) {
                    future.completeExceptionally(e)
                }

                override fun onResponse(
                    call: okhttp3.Call,
                    response: okhttp3.Response,
                ) {
                    response.use {
                        if (!it.isSuccessful) {
                            future.completeExceptionally(IllegalStateException("HTTP ${it.code}"))
                            return
                        }
                        runCatching { http.parse(it, type) }
                            .onSuccess(future::complete)
                            .onFailure(future::completeExceptionally)
                    }
                }
            },
        )
        return future
    }

    private fun executeMap(request: Request): CompletableFuture<Map<String, Any?>> {
        val future = CompletableFuture<Map<String, Any?>>()
        http.client().newCall(request).enqueue(
            object : okhttp3.Callback {
                override fun onFailure(
                    call: okhttp3.Call,
                    e: java.io.IOException,
                ) {
                    future.completeExceptionally(e)
                }

                override fun onResponse(
                    call: okhttp3.Call,
                    response: okhttp3.Response,
                ) {
                    response.use {
                        if (!it.isSuccessful) {
                            future.completeExceptionally(IllegalStateException("HTTP ${it.code}"))
                            return
                        }
                        val text = it.body!!.string()
                        val node = http.mapper.readTree(text).get("data") ?: http.mapper.readTree(text)
                        val map: Map<String, Any?> = http.mapper.readValue(node.toString())
                        future.complete(map)
                    }
                }
            },
        )
        return future
    }

    private fun executeBool(request: Request): CompletableFuture<Boolean> =
        execute(request, Map::class.java).thenApply { (it["data"] as? Map<*, *>)?.get("ok") == true }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class Package(
        val slug: String,
        val name: String,
        val type: String,
        val author: String?,
        val latestVersion: String?,
        val description: String?,
        val deprecated: Boolean = false,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class PageEnvelope(
        val code: Int,
        val data: PageData?,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class PageData(
        val total: Int,
        val items: List<Package>,
    )
}
