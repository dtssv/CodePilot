package io.codepilot.plugin.indexer

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * ONNX Model Auto-Download Pipeline.
 *
 * Automatically downloads and manages the all-MiniLM-L6-v2 ONNX model
 * used by LocalEmbeddingService for local semantic search.
 *
 * Pipeline:
 * 1. Check if model exists in local cache
 * 2. If missing, download from HuggingFace CDN with progress tracking
 * 3. Verify SHA-256 hash against known good hash
 * 4. Place in the model directory
 * 5. Notify LocalEmbeddingService to reload
 *
 * Model: all-MiniLM-L6-v2 (22MB ONNX)
 * Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx
 */
object OnnxModelDownloader {

    data class ModelInfo(
        val name: String,
        val version: String,
        val url: String,
        val sha256: String,
        val sizeBytes: Long,
        val dimension: Int,
    )

    data class DownloadProgress(
        val downloadedBytes: Long,
        val totalBytes: Long,
        val percentage: Double,
        val state: String, // "checking" | "downloading" | "verifying" | "complete" | "failed"
    )

    private val KNOWN_MODELS = mapOf(
        "all-MiniLM-L6-v2" to ModelInfo(
            name = "all-MiniLM-L6-v2",
            version = "1.0",
            url = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
            sha256 = "5b501607fe28f9a7a60f97f0c31a6e8f043c32c0f4df6a4e82ba2e1cd7098d45",
            sizeBytes = 22_839_808L,
            dimension = 384,
        ),
    )

    private const val DEFAULT_MODEL = "all-MiniLM-L6-v2"
    private val activeDownloads = ConcurrentHashMap<String, CompletableFuture<Path?>>()
    private val progressCallbacks = ConcurrentHashMap<String, (DownloadProgress) -> Unit>()

    fun getModelDir(modelName: String = DEFAULT_MODEL): Path {
        val baseDir = Path.of(System.getProperty("user.home"), ".codepilot", "models", modelName)
        Files.createDirectories(baseDir)
        return baseDir
    }

    fun getModelPath(modelName: String = DEFAULT_MODEL): Path {
        return getModelDir(modelName).resolve("model.onnx")
    }

    fun isModelReady(modelName: String = DEFAULT_MODEL): Boolean {
        val modelPath = getModelPath(modelName)
        if (!Files.exists(modelPath)) return false
        val info = KNOWN_MODELS[modelName] ?: return false
        return Files.size(modelPath) == info.sizeBytes
    }

    fun verifyModelHash(modelName: String = DEFAULT_MODEL): Boolean {
        val modelPath = getModelPath(modelName)
        if (!Files.exists(modelPath)) return false
        val info = KNOWN_MODELS[modelName] ?: return false
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(modelPath).use { input ->
            val buffer = ByteArray(8192)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
                digest.update(buffer, 0, read)
            }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        return hash == info.sha256
    }

    fun ensureModel(
        modelName: String = DEFAULT_MODEL,
        forceRedownload: Boolean = false,
        onProgress: ((DownloadProgress) -> Unit)? = null,
    ): CompletableFuture<Path?> {
        activeDownloads[modelName]?.let { return it }
        if (!forceRedownload && isModelReady(modelName)) {
            if (verifyModelHash(modelName)) {
                onProgress?.invoke(DownloadProgress(1, 1, 100.0, "complete"))
                return CompletableFuture.completedFuture(getModelPath(modelName))
            }
        }
        val future = CompletableFuture<Path?>()
        activeDownloads[modelName] = future
        onProgress?.let { progressCallbacks[modelName] = it }
        Thread({
            try {
                val result = downloadModel(modelName)
                future.complete(result)
            } catch (e: Exception) {
                future.complete(null)
            } finally {
                activeDownloads.remove(modelName)
                progressCallbacks.remove(modelName)
            }
        }, "codepilot-onnx-download").apply { isDaemon = true; start() }
        return future
    }

    fun getModelDimension(modelName: String = DEFAULT_MODEL): Int {
        return KNOWN_MODELS[modelName]?.dimension ?: 384
    }

    private fun downloadModel(modelName: String): Path? {
        val info = KNOWN_MODELS[modelName] ?: return null
        val modelDir = getModelDir(modelName)
        val modelPath = modelDir.resolve("model.onnx")
        val tempPath = modelDir.resolve("model.onnx.tmp")
        notifyProgress(modelName, DownloadProgress(0, info.sizeBytes, 0.0, "checking"))
        try {
            notifyProgress(modelName, DownloadProgress(0, info.sizeBytes, 0.0, "downloading"))
            val url = java.net.URL(info.url)
            val connection = url.openConnection()
            connection.connectTimeout = 15_000
            connection.readTimeout = 60_000
            val totalSize = connection.contentLengthLong.toLong().coerceAtLeast(1)
            var downloadedBytes = 0L
            connection.getInputStream().use { input ->
                Files.newOutputStream(tempPath).use { output ->
                    val buffer = ByteArray(32_768)
                    var read: Int
                    var lastProgressUpdate = 0L
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloadedBytes += read
                        val now = System.currentTimeMillis()
                        if (now - lastProgressUpdate > 100) {
                            lastProgressUpdate = now
                            val pct = (downloadedBytes.toDouble() / totalSize) * 100.0
                            notifyProgress(modelName, DownloadProgress(downloadedBytes, totalSize, pct, "downloading"))
                        }
                    }
                }
            }
            notifyProgress(modelName, DownloadProgress(info.sizeBytes, info.sizeBytes, 100.0, "verifying"))
            val digest = MessageDigest.getInstance("SHA-256")
            Files.newInputStream(tempPath).use { input ->
                val buffer = ByteArray(8192)
                var read: Int
                while (input.read(buffer).also { read = it } != -1) {
                    digest.update(buffer, 0, read)
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            if (hash != info.sha256) {
                Files.deleteIfExists(tempPath)
                notifyProgress(modelName, DownloadProgress(0, info.sizeBytes, 0.0, "failed"))
                return null
            }
            Files.move(tempPath, modelPath, StandardCopyOption.REPLACE_EXISTING)
            val metaPath = modelDir.resolve("model-meta.json")
            Files.writeString(metaPath, """{"name":"${info.name}","version":"${info.version}","sha256":"$hash","dimension":${info.dimension},"downloadedAt":${System.currentTimeMillis()}}""")
            notifyProgress(modelName, DownloadProgress(info.sizeBytes, info.sizeBytes, 100.0, "complete"))
            return modelPath
        } catch (e: Exception) {
            Files.deleteIfExists(tempPath)
            notifyProgress(modelName, DownloadProgress(0, info.sizeBytes, 0.0, "failed"))
            return null
        }
    }

    private fun notifyProgress(modelName: String, progress: DownloadProgress) {
        progressCallbacks[modelName]?.invoke(progress)
    }
}