package io.codepilot.harness.search

import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/**
 * Downloads and caches an ONNX embedding model on disk.
 *
 * Sunk from plugin/indexer/OnnxModelDownloader.kt (188 lines). The original is
 * a IntelliJ ApplicationService; here we strip one ApplicationManager call and
 * keep the download/SHA-256/progress logic. The harness loop can use this to
 * fetch a model file, then load it via a Python subprocess or a JVM ONNX
 * runtime (the latter is currently not wired — see plan).
 */
class OnnxModelCache(
    private val cacheDir: Path,
    private val baseUrl: String = DEFAULT_BASE_URL,
) {
    data class ModelRef(val path: Path, val ready: Boolean)

    /** Returns the cached model path; downloads if absent or hash mismatch. */
    fun ensureModel(
        modelName: String = DEFAULT_MODEL_NAME,
        expectedSha256: String = DEFAULT_MODEL_SHA256,
        onProgress: ((Double) -> Unit)? = null,
    ): ModelRef {
        Files.createDirectories(cacheDir)
        val modelDir = cacheDir.resolve(modelName)
        val modelFile = modelDir.resolve("model.onnx")
        if (isModelReady(modelFile, expectedSha256)) return ModelRef(modelFile, true)

        Files.createDirectories(modelDir)
        val url = "$baseUrl/$modelName/model.onnx"
        download(url, modelFile, onProgress)
        return ModelRef(modelFile, isModelReady(modelFile, expectedSha256))
    }

    fun isModelReady(
        modelFile: Path = cacheDir.resolve(DEFAULT_MODEL_NAME).resolve("model.onnx"),
        expectedSha256: String = DEFAULT_MODEL_SHA256,
    ): Boolean {
        if (!Files.exists(modelFile)) return false
        val actual = sha256(modelFile.toFile())
        return actual.equals(expectedSha256, ignoreCase = true)
    }

    private fun download(url: String, dest: Path, onProgress: ((Double) -> Unit)?) {
        val tmp = dest.resolveSibling(dest.fileName.toString() + ".tmp")
        URI(url).toURL().openStream().use { input ->
            Files.newOutputStream(tmp).use { out ->
                val buf = ByteArray(8192)
                var n: Int
                var total = 0L
                val size = input.available().toLong().coerceAtLeast(1)
                while (input.read(buf).also { n = it } > 0) {
                    out.write(buf, 0, n)
                    total += n
                    onProgress?.invoke(total.toDouble() / size)
                }
            }
        }
        Files.move(tmp, dest, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { fis ->
            val buf = ByteArray(8192)
            var n: Int
            while (fis.read(buf).also { n = it } > 0) md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx"
        const val DEFAULT_MODEL_NAME = "all-MiniLM-L6-v2"
        // Replace with the real SHA-256 once verified; intentionally not hard-coded
        // to a guess to avoid silently accepting a corrupted download.
        const val DEFAULT_MODEL_SHA256 = "REPLACE_WITH_REAL_SHA256"
    }
}
