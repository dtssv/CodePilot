package io.codepilot.plugin.marketplace

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.util.concurrent.CompletableFuture

/**
 * Third-Party Registry End-to-End Verification Flow.
 * Full flow: discover → fetch → signature verify → user consent → download → hash verify → install → notify
 */
object RegistryE2EVerifier {

    data class VerificationResult(
        val success: Boolean,
        val stage: String,
        val message: String,
        val details: Map<String, String>?,
    )

    fun installFromRegistry(
        project: Project, registryUrl: String, packageSlug: String, version: String? = null,
    ): CompletableFuture<VerificationResult> {
        val future = CompletableFuture<VerificationResult>()
        Thread({
            try {
                // Stage 1: Discover
                val manifest = ThirdPartyRegistryClient.discoverRegistry(registryUrl)
                if (manifest == null) {
                    future.complete(VerificationResult(false, "discover", "Failed to discover registry at $registryUrl", null)); return@Thread
                }
                // Stage 2: Fetch detail
                val detail = ThirdPartyRegistryClient.getPackageDetail(registryUrl, packageSlug)
                if (detail == null) {
                    future.complete(VerificationResult(false, "fetch", "Package '$packageSlug' not found", null)); return@Thread
                }
                // Stage 3: Verify signature
                val sigValid = ThirdPartyRegistryClient.verifySignature(detail, registryUrl)
                if (!sigValid) {
                    future.complete(VerificationResult(false, "signature", "Signature verification failed for '${detail.title}'", mapOf("slug" to packageSlug))); return@Thread
                }
                // Stage 4: User consent
                val consentGiven = askUserConsent(project, detail, manifest.name)
                if (!consentGiven) {
                    future.complete(VerificationResult(false, "consent", "User declined", null)); return@Thread
                }
                // Stage 5: Download
                val bytes = ThirdPartyRegistryClient.downloadPackage(registryUrl, packageSlug, version)
                if (bytes == null) {
                    future.complete(VerificationResult(false, "download", "Download failed for '$packageSlug'", null)); return@Thread
                }
                // Stage 6: Hash verify
                if (detail.sha256 != null) {
                    val actualHash = sha256Hex(bytes)
                    if (actualHash != detail.sha256.lowercase()) {
                        future.complete(VerificationResult(false, "hash", "Hash mismatch", mapOf("expected" to detail.sha256, "actual" to actualHash))); return@Thread
                    }
                }
                // Stage 7: Install
                val tempFile = java.io.File.createTempFile("codepilot-pkg-${detail.slug}", ".zip")
                tempFile.writeBytes(bytes)
                tempFile.deleteOnExit()
                val installer = PackageInstaller(project = project)
                installer.installFromArchive(tempFile.toPath(), detail.slug, detail.type)
                // Stage 8: Notify
                future.complete(VerificationResult(true, "complete",
                    "'${detail.title}' v${detail.version} installed from ${manifest.name}",
                    mapOf("slug" to packageSlug, "version" to detail.version, "registry" to manifest.name)))
            } catch (e: Exception) {
                future.complete(VerificationResult(false, "error", e.message ?: "Unknown error", null))
            }
        }, "codepilot-registry-install").apply { isDaemon = true; start() }
        return future
    }

    fun verifyRegistry(registryUrl: String): VerificationResult {
        val manifest = ThirdPartyRegistryClient.discoverRegistry(registryUrl)
            ?: return VerificationResult(false, "discover", "Cannot reach registry at $registryUrl", null)
        val packages = ThirdPartyRegistryClient.listPackages(registryUrl)
        return VerificationResult(true, "verified",
            "Registry '${manifest.name}' verified with ${packages.size} packages",
            mapOf("name" to manifest.name, "packages" to packages.size.toString(),
                "hasPublicKey" to (manifest.publicKeyPem != null).toString()))
    }

    private var consentResult: Boolean? = null

    private fun askUserConsent(project: Project, detail: ThirdPartyRegistryClient.PackageDetail, registryName: String): Boolean {
        consentResult = null
        ApplicationManager.getApplication().invokeAndWait {
            val perms = detail.permissions?.joinToString("\n") ?: "No special permissions"
            val msg = "Package: ${detail.title} v${detail.version}\nAuthor: ${detail.author ?: "Unknown"}\nRegistry: $registryName\n\nPermissions:\n$perms\n\nInstall this package?"
            consentResult = Messages.showYesNoDialog(project, msg, "Install from Third-Party Registry", null) == Messages.YES
        }
        return consentResult ?: false
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }
}