package io.codepilot.plugin.marketplace

import com.intellij.openapi.diagnostic.Logger
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * Package installer implementing the 8-step installation flow from 01-架构设计.md §6.5:
 * 1. resolve → 2. preflight → 3. verify → 4. consent → 5. scope-pick → 6. extract → 7. activate → 8. report
 */
class PackageInstaller(
    private val client: MarketplaceClient = MarketplaceClient(),
    private val localStore: LocalMarketplaceStore = LocalMarketplaceStore.getInstance(),
    private val project: com.intellij.openapi.project.Project? = null,
) {
    private val log = Logger.getInstance(PackageInstaller::class.java)

    data class InstallResult(
        val success: Boolean,
        val slug: String,
        val version: String,
        val scope: LocalMarketplaceStore.Scope,
        val error: String? = null,
    )

    fun install(
        slug: String,
        version: String,
        scope: LocalMarketplaceStore.Scope,
    ): InstallResult {
        return try {
            // Step 1: Resolve
            val manifest = client.skillManifest(slug, version).get()

            // Step 2: Preflight
            val preflightError = preflight(manifest)
            if (preflightError != null) {
                return InstallResult(false, slug, version, scope, preflightError)
            }

            // Step 3: Download + verify
            val downloadInfo = client.skillDownload(slug, version).get()
            val artifactUrl =
                resolveArtifactUrl(
                    downloadInfo.url?.takeIf { it.isNotBlank() }
                        ?: return InstallResult(false, slug, version, scope, "Server returned no artifact URL"),
                )
            val downloadBytes = downloadFile(artifactUrl)
            val expectedSha = downloadInfo.sha256?.trim().orEmpty()
            if (expectedSha.isNotEmpty() && !verifySha256(expectedSha, downloadBytes)) {
                return InstallResult(false, slug, version, scope, "SHA-256 verification failed")
            }

            // Step 4: Consent — show confirmation dialog for third-party packages
            val sourceType = manifest["source"] as? String ?: "user"
            if (sourceType != "system") {
                val consentResult = showConsentDialog(manifest, slug, version)
                if (!consentResult) {
                    return InstallResult(false, slug, version, scope, "User declined installation")
                }
            }

            // Step 5: Install path
            val installDir = localStore.getInstallDir(slug, version, scope, project)

            // Step 6: Extract
            extractZip(downloadBytes, installDir)
            localStore.recordInstall(slug, version, scope, LocalMarketplaceStore.Source.OFFICIAL, manifest, project)

            // Step 7: Activate
            localStore.reloadIndex()

            // Step 8: Report
            try {
                client.reportInstall(slug, version, scope, LocalMarketplaceStore.Source.OFFICIAL).get()
            } catch (e: Exception) {
                log.warn("Failed to report install: ${e.message}")
            }

            InstallResult(true, slug, version, scope)
        } catch (e: Exception) {
            log.error("Install failed for $slug@$version", e)
            InstallResult(false, slug, version, scope, "Install failed: ${e.message}")
        }
    }

    /**
     * Install a package from a local archive file (zip).
     * Used by the E2E verifier after downloading and validating a package.
     *
     * @param archivePath Path to the zip archive
     * @param slug Package slug identifier
     * @param type Package type (e.g. "mcp-server", "skill")
     * @return InstallResult indicating success or failure
     */
    fun installFromArchive(
        archivePath: java.nio.file.Path,
        slug: String,
        type: String,
    ): InstallResult {
        return try {
            val bytes = java.nio.file.Files.readAllBytes(archivePath)
            val scope = LocalMarketplaceStore.Scope.PROJECT

            // Determine install directory
            val installDir = localStore.getInstallDir(slug, "local", scope, project)

            // Extract archive
            extractZip(bytes, installDir)

            // Record installation
            val manifest = mapOf<String, Any?>(
                "slug" to slug,
                "type" to type,
                "version" to "local",
                "source" to "archive",
            )
            localStore.recordInstall(slug, "local", scope, LocalMarketplaceStore.Source.LOCAL, manifest, project)
            localStore.reloadIndex()

            InstallResult(true, slug, "local", scope)
        } catch (e: Exception) {
            log.error("Archive install failed for $slug", e)
            InstallResult(false, slug, "local", LocalMarketplaceStore.Scope.PROJECT, "Archive install failed: ${e.message}")
        }
    }

    private fun preflight(manifest: Map<String, Any?>): String? {
        @Suppress("UNCHECKED_CAST")
        val permissions = manifest["permissions"] as? Map<String, Any?>
        if (permissions != null) {
            val tools = permissions["tools"] as? List<String>
            if (tools != null) {
                val allowedTools = getAllowedTools()
                val unauthorized = tools.filter { !allowedTools.contains(it) }
                if (unauthorized.isNotEmpty()) {
                    return "Package requires unauthorized tools: ${unauthorized.joinToString()}"
                }
            }
        }
        @Suppress("UNCHECKED_CAST")
        val dependencies = manifest["dependencies"] as? List<Map<String, Any?>>
        if (dependencies != null) {
            for (dep in dependencies) {
                val depId = dep["id"] as? String ?: continue
                if (!localStore.isInstalled(depId)) {
                    return "Missing dependency: $depId"
                }
            }
        }
        return null
    }

    private fun verifySha256(
        expected: String,
        data: ByteArray,
    ): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(data)
        val actual = hash.joinToString("") { "%02x".format(it) }
        return expected.equals(actual, ignoreCase = true)
    }

    private fun extractZip(
        data: ByteArray,
        targetDir: Path,
    ) {
        Files.createDirectories(targetDir)
        ZipInputStream(data.inputStream()).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val entryPath = targetDir.resolve(entry.name)
                if (!entryPath.normalize().startsWith(targetDir.normalize())) {
                    throw SecurityException("Zip slip: ${entry.name}")
                }
                if (entry.isDirectory) {
                    Files.createDirectories(entryPath)
                } else {
                    Files.createDirectories(entryPath.parent)
                    Files.copy(zis, entryPath, StandardCopyOption.REPLACE_EXISTING)
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }

    /**
     * Backend may return relative paths like `/v1/skills/packages/.../archive` alongside the site's base URL.
     */
    private fun resolveArtifactUrl(url: String): String {
        val u = url.trim()
        if (u.startsWith("http://", ignoreCase = true) || u.startsWith("https://", ignoreCase = true)) {
            return u
        }
        val base = CodePilotSettings.getInstance().state.backendBaseUrl.trimEnd('/')
        if (u.startsWith("/")) return base + u
        return "$base/$u"
    }

    private fun downloadFile(url: String): ByteArray {
        val request =
            okhttp3.Request
                .Builder()
                .url(url)
                .get()
                .build()
        val response =
            HttpClientService
                .getInstance()
                .client()
                .newCall(request)
                .execute()
        if (!response.isSuccessful) throw IllegalStateException("Download failed: HTTP ${response.code}")
        return response.body?.bytes() ?: throw IllegalStateException("Empty response")
    }

    private fun getAllowedTools(): Set<String> =
        setOf(
            "fs.read",
            "fs.list",
            "fs.search",
            "fs.grep",
            "fs.outline",
            "code.outline",
            "code.symbol",
            "code.usages",
            "fs.create",
            "fs.write",
            "fs.replace",
            "fs.delete",
            "fs.move",
            "shell.exec",
            "shell.session",
            "ide.openFile",
            "ide.diagnostics",
            "ide.applyPatch",
            "plan.show",
            "plan.update",
        )

    /**
     * Show the consent confirmation dialog (Step 4).
     * Returns true if user agrees, false if declined.
     */
    private fun showConsentDialog(
        manifest: Map<String, Any?>,
        slug: String,
        version: String,
    ): Boolean {
        if (project == null) {
            // Non-UI context (tests, headless) — skip consent
            log.warn("No project context available, skipping consent dialog for $slug")
            return true
        }

        val description = manifest["description"] as? String ?: "No description available"

        @Suppress("UNCHECKED_CAST")
        val permissions = manifest["permissions"] as? Map<String, Any?> ?: emptyMap()

        val signatureSubject = manifest["signatureSubject"] as? String
        val signatureValid = manifest["signatureValid"] as? Boolean ?: false
        val license = manifest["license"] as? String

        // Determine risk level
        val riskLevel = determineRiskLevel(permissions, signatureValid)

        val dialog =
            PackageConsentDialog(
                project = project,
                packageName = slug,
                version = version,
                description = description,
                permissions = permissions,
                signatureSubject = signatureSubject,
                signatureValid = signatureValid,
                license = license,
                riskLevel = riskLevel,
            )

        return dialog.showAndGet()
    }

    private fun determineRiskLevel(
        permissions: Map<String, Any?>,
        signatureValid: Boolean,
    ): PackageConsentDialog.RiskLevel {
        if (!signatureValid) return PackageConsentDialog.RiskLevel.HIGH

        @Suppress("UNCHECKED_CAST")
        val tools = permissions["tools"] as? List<String> ?: emptyList()
        val hasDangerousTool = tools.any { it in PackageConsentDialog.DANGEROUS_TOOLS }
        val hasNetworkAccess = permissions["network"] as? Boolean == true
        val hasFsWrite = permissions["fsWrite"] as? Boolean == true
        val hasEnvAccess = permissions["env"] as? Boolean == true

        val dangerousCount =
            listOf(hasDangerousTool, hasNetworkAccess, hasFsWrite, hasEnvAccess)
                .count { it }

        return when {
            dangerousCount >= 3 -> PackageConsentDialog.RiskLevel.HIGH
            dangerousCount >= 1 -> PackageConsentDialog.RiskLevel.MEDIUM
            else -> PackageConsentDialog.RiskLevel.LOW
        }
    }
}
