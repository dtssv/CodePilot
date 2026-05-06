package io.codepilot.plugin.update

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.Request
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.zip.ZipInputStream

/**
 * Downloads and applies plugin updates.
 *
 * Hot-patch: extracts allowed resources from zip, verifies sha256 + signature, atomically
 * switches via RuntimeResourceRegistry.
 *
 * Full update: writes full zip to IDE's pluginsTemp/ directory for install on next restart.
 */
@Service(Service.Level.APP)
class HotPatchService {

    private val log = logger<HotPatchService>()
    private val mapper = ObjectMapper()

    /** Resources that can be hot-patched without restart. */
    private val hotPatchWhitelist = setOf(
        "webui/", "prompts/", "tool-schemas/", "skills/builtin/"
    )

    /**
     * Apply a hot-patch: download, verify, extract whitelisted resources, atomic switch.
     * Returns true if hot-patch was applied successfully.
     */
    fun applyHotPatch(manifest: JsonNode, project: Project?): Boolean {
        val downloadUrl = manifest.path("hotPatchUrl").asText(null) ?: return false
        val expectedSha256 = manifest.path("sha256").asText(null) ?: return false
        val signatureB64 = manifest.path("signature").asText(null) ?: return false

        try {
            // 1. Download the zip
            val zipBytes = downloadZip(downloadUrl) ?: return false

            // 2. Verify SHA-256
            val actualSha256 = sha256Hex(zipBytes)
            if (!actualSha256.equals(expectedSha256, ignoreCase = true)) {
                log.error("SHA-256 mismatch: expected=$expectedSha256, actual=$actualSha256")
                return false
            }

            // 3. Verify signature
            if (!verifySignature(zipBytes, signatureB64)) {
                log.error("Signature verification failed for hot-patch")
                return false
            }

            // 4. Extract only whitelisted resources to a temp directory
            val tempDir = Files.createTempDirectory("codepilot-hotpatch-")
            extractWhitelisted(zipBytes, tempDir)

            // 5. Atomic switch via RuntimeResourceRegistry
            val registry = RuntimeResourceRegistry.getInstance()
            registry.atomicSwitch(tempDir)

            notifySuccess(project, manifest.path("version").asText(""))
            log.info("Hot-patch applied successfully")
            return true
        } catch (e: Exception) {
            log.error("Hot-patch failed", e)
            return false
        }
    }

    /**
     * Full update: write zip to pluginsTemp/ for install on next restart.
     * Notifies user to restart.
     */
    fun scheduleFullUpdate(manifest: JsonNode, project: Project?): Boolean {
        val downloadUrl = manifest.path("fullZipUrl").asText(null) ?: return false
        val expectedSha256 = manifest.path("sha256").asText(null) ?: return false
        val signatureB64 = manifest.path("signature").asText(null) ?: return false

        try {
            val zipBytes = downloadZip(downloadUrl) ?: return false

            // Verify integrity
            val actualSha256 = sha256Hex(zipBytes)
            if (!actualSha256.equals(expectedSha256, ignoreCase = true)) {
                log.error("SHA-256 mismatch for full update")
                return false
            }
            if (!verifySignature(zipBytes, signatureB64)) {
                log.error("Signature verification failed for full update")
                return false
            }

            // Write to pluginsTemp/
            val pluginsTemp = Path.of(PathManager.getPluginTempPath())
            Files.createDirectories(pluginsTemp)
            val targetFile = pluginsTemp.resolve("codepilot-update.zip")
            Files.write(targetFile, zipBytes)

            notifyRestart(project, manifest.path("version").asText(""))
            log.info("Full update staged at: $targetFile")
            return true
        } catch (e: Exception) {
            log.error("Full update staging failed", e)
            return false
        }
    }

    // ---- Private ---- //

    private fun downloadZip(url: String): ByteArray? {
        val http = HttpClientService.getInstance()
        val request = Request.Builder().url(url).get().build()
        val response = http.client().newCall(request).execute()
        return response.use {
            if (!it.isSuccessful) {
                log.warn("Download failed: HTTP ${it.code}")
                null
            } else {
                it.body?.bytes()
            }
        }
    }

    private fun sha256Hex(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(data)
        return hash.joinToString("") { "%02x".format(it) }
    }

    private fun verifySignature(data: ByteArray, signatureB64: String): Boolean {
        val certStream: InputStream = javaClass.getResourceAsStream("/codepilot-signing.crt")
            ?: run {
                log.warn("Signing certificate not found in resources")
                return false
            }
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(certStream) as X509Certificate
        val sig = Signature.getInstance("SHA256withRSA")
        sig.initVerify(cert.publicKey)
        sig.update(data)
        val signatureBytes = java.util.Base64.getDecoder().decode(signatureB64)
        return sig.verify(signatureBytes)
    }

    private fun extractWhitelisted(zipBytes: ByteArray, targetDir: Path) {
        ZipInputStream(zipBytes.inputStream()).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val name = entry.name
                val allowed = hotPatchWhitelist.any { name.startsWith(it) }
                if (allowed && !entry.isDirectory) {
                    val dest = targetDir.resolve(name)
                    Files.createDirectories(dest.parent)
                    Files.copy(zis, dest, StandardCopyOption.REPLACE_EXISTING)
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }

    private fun notifySuccess(project: Project?, version: String) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup("CodePilot")
        group.createNotification(
            "CodePilot hot-patch applied",
            "Updated to $version without restart.",
            NotificationType.INFORMATION,
        ).notify(project)
    }

    private fun notifyRestart(project: Project?, version: String) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup("CodePilot")
        group.createNotification(
            "CodePilot $version ready to install",
            "Please restart your IDE to complete the update.",
            NotificationType.WARNING,
        ).notify(project)
    }

    companion object {
        @JvmStatic fun getInstance(): HotPatchService = service()
    }
}