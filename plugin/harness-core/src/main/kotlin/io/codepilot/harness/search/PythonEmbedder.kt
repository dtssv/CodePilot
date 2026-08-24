package io.codepilot.harness.search

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.writeText

/**
 * Sentence-transformers embedder via a Python subprocess.
 *
 * This replaces the never-wired-up ONNX reflection path (the plan calls this
 * out explicitly as "子进程机会"). When the user has Python + the
 * sentence-transformers package installed, this produces real transformer
 * embeddings — far higher quality than [TfidfEmbedder].
 *
 * Communication protocol (JSON over stdin/stdout):
 *   - Launch:  python3 <scriptPath>
 *   - Request: {"op":"embed","text":"..."}\n
 *   - Response: {"embedding":[0.1,0.2,...]}\n  or  {"error":"..."}
 *
 * The subprocess stays resident for the process lifetime (no model reload per
 * call). If Python or the package is missing, [available] returns false and
 * callers should fall back to [TfidfEmbedder].
 */
class PythonEmbedder(
    private val pythonPath: String = "python3",
    private val scriptPath: Path,
    override val dimension: Int = 384,
) : Embedder {
    override val name = "python-sentence-transformers"

    @Volatile private var process: Process? = null
    @Volatile private var _available: Boolean? = null

    val available: Boolean
        get() = ensureStarted()

    /** Launch the subprocess and warm up the model. Returns false if unavailable. */
    private fun ensureStarted(): Boolean {
        if (_available != null) return _available!!
        if (!scriptPath.exists()) {
            // Self-install the runner script if missing.
            runCatching { scriptPath.parent?.let { File(it.toString()).mkdirs() }; scriptPath.writeText(RUNNER_SCRIPT) }
            if (!scriptPath.exists()) { _available = false; return false }
        }
        _available = try {
            val p = ProcessBuilder(pythonPath, scriptPath.toString())
                .redirectErrorStream(false).start()
            process = p
            // Send a warmup ping; if Python fails to import, it exits with an error
            // and we fall back to TfidfEmbedder.
            p.outputStream.write("{\"op\":\"warmup\"}\n".toByteArray())
            p.outputStream.flush()
            val resp = p.inputStream.bufferedReader().readLine()
            !resp.isNullOrBlank() && !resp.contains("error")
        } catch (_: Exception) {
            false
        }
        _available!!
    }

    override suspend fun embed(text: String): FloatArray = withContext(Dispatchers.IO) {
        val p = process ?: return@withContext FloatArray(dimension)
        try {
            val req = kotlinx.serialization.json.buildJsonObject {
                put("op", "embed")
                put("text", text)
            }.toString() + "\n"
            p.outputStream.write(req.toByteArray())
            p.outputStream.flush()
            val line = p.inputStream.bufferedReader().readLine() ?: return@withContext FloatArray(dimension)
            val obj = kotlinx.serialization.json.Json.parseToJsonElement(line) as? kotlinx.serialization.json.JsonObject
                ?: return@withContext FloatArray(dimension)
            val arr = obj["embedding"] as? kotlinx.serialization.json.JsonArray
                ?: return@withContext FloatArray(dimension)
            FloatArray(arr.size) { i ->
                (arr[i] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toFloat() ?: 0f
            }
        } catch (_: Exception) {
            FloatArray(dimension)
        }
    }

    fun close() {
        process?.destroyForcibly()
        process = null
        _available = null
    }

    protected fun finalize() = close()

    companion object {
        private const val RUNNER_SCRIPT = """
import sys
import json
try:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    print(json.dumps({"status": "ready"}))
    sys.stdout.flush()
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.stdout.flush()
    sys.exit(1)

for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("op") == "warmup":
        print(json.dumps({"status": "ready"}))
        sys.stdout.flush()
        continue
    if req.get("op") == "embed":
        emb = model.encode(req.get("text", "")).tolist()
        print(json.dumps({"embedding": emb}))
        sys.stdout.flush()
"""
    }
}
