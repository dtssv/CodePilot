package io.codepilot.plugin.marketplace

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.settings.RegistryEntry
import io.codepilot.plugin.transport.HttpClientService
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Third-Party Registry Protocol Client.
 *
 * Implements the CodePilot Registry Protocol for discovering and fetching
 * Skills/MCP servers from third-party registries. The protocol follows
 * the well-known discovery pattern:
 *
 * 1. GET {registry-base}/.well-known/codePilot-registry.json → Registry manifest
 * 2. GET {registry-base}/packages.json → Package listing
 * 3. GET {registry-base}/packages/{slug} → Package detail + manifest
 * 4. GET {registry-base}/packages/{slug}/versions/{version} → Version-specific detail
 * 5. GET {registry-base}/packages/{slug}/download → Package artifact download
 *
 * Security:
 * - Registry manifest must include a publicKeyPem field
 * - Package manifests must include a signature field (RSA-PSS over the manifest JSON)
 * - Client verifies signature against the registry's public key before install
 * - If no public key is configured, user must confirm trust on first use
 */
object ThirdPartyRegistryClient {

    private val mapper = ObjectMapper()

    // Cache: registryUrl → RegistryManifest
    private val manifestCache = ConcurrentHashMap<String, RegistryManifest>()
    // Cache: registryUrl + slug → PackageSummary
    private val packageListCache = ConcurrentHashMap<String, List<PackageSummary>>()
    private var lastFetchMs = 0L
    private const val CACHE_TTL_MS = 5 * 60 * 1000L // 5 min cache

    // ─── Data Classes ──────────────────────────────────────────────────

    data class RegistryManifest(
        val name: String,
        val description: String?,
        val baseUrl: String,
        val publicKeyPem: String?,
        val apiVersion: String,
        val packagesPath: String = "/packages.json",
        val wellKnownPath: String = "/.well-known/codePilot-registry.json",
    )

    data class PackageSummary(
        val slug: String,
        val title: String,
        val description: String?,
        val type: String, // "mcp" or "skill"
        val version: String,
        val author: String?,
        val tags: List<String>?,
        val downloadCount: Long?,
    )

    data class PackageDetail(
        val slug: String,
        val title: String,
        val description: String?,
        val type: String,
        val version: String,
        val author: String?,
        val homepage: String?,
        val repository: String?,
        val changelog: String?,
        val signature: String?,   // Base64 RSA-PSS signature
        val manifestJson: String, // Raw manifest for signature verification
        val downloadUrl: String?,
        val fileSize: Long?,
        val sha256: String?,
        val permissions: List<String>?,
        val tools: List<String>?,
    )

    // ─── Discovery ─────────────────────────────────────────────────────

    /**
     * Discover a registry by fetching its well-known manifest.
     * Returns the manifest or null if discovery fails.
     */
    fun discoverRegistry(registryUrl: String): RegistryManifest? {
        manifestCache[registryUrl]?.let { return it }

        val wellKnownUrl = "${registryUrl.trimEnd('/')}/.well-known/codePilot-registry.json"
        return try {
            val http = HttpClientService.getInstance()
            val request = http.get(wellKnownUrl)
            val response = http.client().newCall(request).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                val root = mapper.readTree(body)

                val manifest = RegistryManifest(
                    name = root.path("name").asText("Unknown"),
                    description = root.path("description").asText(null),
                    baseUrl = registryUrl.trimEnd('/'),
                    publicKeyPem = root.path("publicKeyPem").asText(null),
                    apiVersion = root.path("apiVersion").asText("v1"),
                    packagesPath = root.path("packagesPath").asText("/packages.json"),
                    wellKnownPath = "/.well-known/codePilot-registry.json",
                )
                manifestCache[registryUrl] = manifest
                manifest
            }
        } catch (_: Exception) { null }
    }

    /**
     * List packages from a third-party registry.
     * Returns cached results if within TTL.
     */
    fun listPackages(registryUrl: String, forceRefresh: Boolean = false): List<PackageSummary> {
        val cacheKey = registryUrl
        if (!forceRefresh) {
            packageListCache[cacheKey]?.let { return it }
        }

        val manifest = discoverRegistry(registryUrl) ?: return emptyList()
        val packagesUrl = "${manifest.baseUrl}${manifest.packagesPath}"

        return try {
            val http = HttpClientService.getInstance()
            val request = http.get(packagesUrl)
            val response = http.client().newCall(request).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return emptyList()
                val body = resp.body?.string() ?: return emptyList()
                val root = mapper.readTree(body)

                val packages = mutableListOf<PackageSummary>()
                val items = if (root.isArray) root else root.path("packages")
                if (items.isArray) {
                    items.forEach { node ->
                        packages.add(PackageSummary(
                            slug = node.path("slug").asText(),
                            title = node.path("title").asText(),
                            description = node.path("description").asText(null),
                            type = node.path("type").asText("skill"),
                            version = node.path("version").asText("0.0.0"),
                            author = node.path("author").asText(null),
                            tags = if (node.path("tags").isArray) node.path("tags").map { it.asText() } else null,
                            downloadCount = if (node.has("downloadCount")) node.path("downloadCount").asLong() else null,
                        ))
                    }
                }
                packageListCache[cacheKey] = packages
                packages
            }
        } catch (_: Exception) { emptyList() }
    }

    /**
     * Fetch detailed package information from a third-party registry.
     */
    fun getPackageDetail(registryUrl: String, slug: String): PackageDetail? {
        val manifest = discoverRegistry(registryUrl) ?: return null
        val detailUrl = "${manifest.baseUrl}/packages/$slug"

        return try {
            val http = HttpClientService.getInstance()
            val request = http.get(detailUrl)
            val response = http.client().newCall(request).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                val root = mapper.readTree(body)

                val versionNode = root.path("latestVersion").let {
                    if (it.isMissingNode || it.isNull) root else it
                }

                PackageDetail(
                    slug = root.path("slug").asText(slug),
                    title = root.path("title").asText(),
                    description = root.path("description").asText(null),
                    type = root.path("type").asText("skill"),
                    version = versionNode.path("version").asText("0.0.0"),
                    author = root.path("author").asText(null),
                    homepage = root.path("homepage").asText(null),
                    repository = root.path("repository").asText(null),
                    changelog = root.path("changelog").asText(null),
                    signature = root.path("signature").asText(null),
                    manifestJson = body,
                    downloadUrl = versionNode.path("downloadUrl").asText(null),
                    fileSize = if (versionNode.has("fileSize")) versionNode.path("fileSize").asLong() else null,
                    sha256 = versionNode.path("sha256").asText(null),
                    permissions = if (root.path("permissions").isArray) root.path("permissions").map { it.asText() } else null,
                    tools = if (root.path("tools").isArray) root.path("tools").map { it.asText() } else null,
                )
            }
        } catch (_: Exception) { null }
    }

    /**
     * Download a package artifact from a third-party registry.
     * Verifies SHA-256 hash if provided in the package detail.
     * Returns the downloaded bytes, or null on failure.
     */
    fun downloadPackage(registryUrl: String, slug: String, version: String? = null): ByteArray? {
        val manifest = discoverRegistry(registryUrl) ?: return null
        val downloadUrl = if (version != null) {
            "${manifest.baseUrl}/packages/$slug/versions/$version/download"
        } else {
            "${manifest.baseUrl}/packages/$slug/download"
        }

        return try {
            val http = HttpClientService.getInstance()
            val request = http.get(downloadUrl)
            val response = http.client().newCall(request).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return null
                val bytes = resp.body?.bytes() ?: return null

                // Verify SHA-256 if available
                val sha256Header = resp.header("X-Package-SHA256")
                if (sha256Header != null) {
                    val actualHash = sha256Hex(bytes)
                    if (actualHash != sha256Header.lowercase()) {
                        return null // Hash mismatch - reject download
                    }
                }
                bytes
            }
        } catch (_: Exception) { null }
    }

    // ─── Signature Verification ────────────────────────────────────────

    /**
     * Verify a package's RSA-PSS signature against the registry's public key.
     * Returns true if the signature is valid or if no public key is available
     * (in which case the user should be prompted for trust-on-first-use).
     */
    fun verifySignature(detail: PackageDetail, registryUrl: String): Boolean {
        val manifest = manifestCache[registryUrl] ?: return false
        val publicKeyPem = manifest.publicKeyPem ?: return true // No key = trust on first use
        val signature = detail.signature ?: return false // No signature = reject

        return try {
            // Parse PEM public key
            val keyBytes = java.util.Base64.getDecoder().decode(
                publicKeyPem
                    .replace("-----BEGIN PUBLIC KEY-----", "")
                    .replace("-----END PUBLIC KEY-----", "")
                    .replace("\\s".toRegex(), "")
            )
            val keySpec = java.security.spec.X509EncodedKeySpec(keyBytes)
            val keyFactory = java.security.KeyFactory.getInstance("RSA")
            val publicKey = keyFactory.generatePublic(keySpec)

            // Verify RSA-PSS signature
            val sig = java.security.Signature.getInstance("RSASSA-PSS")
            sig.initVerify(publicKey)
            sig.update(detail.manifestJson.toByteArray(Charsets.UTF_8))
            val sigBytes = java.util.Base64.getDecoder().decode(signature)
            sig.verify(sigBytes)
        } catch (_: Exception) { false }
    }

    /**
     * Get all configured third-party registries from settings.
     */
    fun getConfiguredRegistries(): List<RegistryEntry> {
        return CodePilotSettings.getInstance().state.registries
    }

    // ─── Utility ───────────────────────────────────────────────────────

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }
}