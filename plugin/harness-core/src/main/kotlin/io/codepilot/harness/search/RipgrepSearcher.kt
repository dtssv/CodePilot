package io.codepilot.harness.search

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Path

/**
 * Ripgrep-backed grep searcher.
 *
 * Ripgrep (rg) is a Rust binary; Claude Code and Cursor both use it for large
 * repo search. This class shells out to `rg --json` and parses the JSON
 * output; when rg is unavailable it falls back to a [Bm25Searcher] grep call.
 *
 * The [Tool] interface is not implemented here — the IDE adapter wraps this
 * searcher as a `grep` tool and the harness loop can also call it directly
 * via [CodeSearcher].
 */
class RipgrepSearcher(
    private val rgPath: Path? = findRipgrep(),
    private val root: Path,
    private val fallback: Bm25Searcher = Bm25Searcher(root),
) : CodeSearcher {

    override suspend fun grep(pattern: String, opts: GrepOpts): List<Hit> = withContext(Dispatchers.IO) {
        val rg = rgPath ?: return@withContext fallback.grep(pattern, opts)
        val args = buildList {
            add(rg.toString()); add("--json"); add("--max-count=${opts.maxHits}")
            if (!opts.caseSensitive) add("--ignore-case")
            if (opts.pathGlob != null) add("--glob=${opts.pathGlob}")
            if (opts.contextLines > 0) add("--context=${opts.contextLines}")
            add(pattern); add(root.toString())
        }
        runCatching {
            val proc = ProcessBuilder(args).redirectErrorStream(false).start()
            val out = proc.inputStream.bufferedReader().readText()
            proc.waitFor()
            parseRgJson(out)
        }.getOrElse { fallback.grep(pattern, opts) }
    }

    override suspend fun semantic(query: String, topK: Int): List<Hit> = fallback.semantic(query, topK)

    /**
     * Parse the `rg --json` output format. Each line is a JSON object with a
     * "type" field: "match" / "context" / "summary" / "end".
     *
     * We only extract "match" entries: { "type": { "label":"match" }, "data": {
     * "path": {"text":...}, "line_number":..., "lines": {"text":...}, ... } }
     */
    private fun parseRgJson(output: String): List<Hit> {
        val hits = mutableListOf<Hit>()
        val parser = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        for (line in output.lines()) {
            if (line.isBlank()) continue
            val element = runCatching { parser.parseToJsonElement(line) }.getOrNull() ?: continue
            val obj = element as? kotlinx.serialization.json.JsonObject ?: continue
            val typeLabel = obj["type"]?.let { (it as? kotlinx.serialization.json.JsonObject)?.get("label") }
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: continue
            if (typeLabel != "match") continue
            val data = obj["data"] as? kotlinx.serialization.json.JsonObject ?: continue
            val path = (data["path"] as? kotlinx.serialization.json.JsonObject)?.get("text")
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: continue
            val lineNo = data["line_number"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() } ?: 0
            val text = (data["lines"] as? kotlinx.serialization.json.JsonObject)?.get("text")
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: ""
            hits.add(Hit(path = path, line = lineNo, lineContent = text.take(300), matchType = "ripgrep"))
        }
        return hits
    }

    companion object {
        /** Best-effort ripgrep discovery. Returns null if not found. */
        fun findRipgrep(): Path? = runCatching {
            val cmd = if (System.getProperty("os.name").lowercase().contains("windows")) "where rg" else "which rg"
            val p = ProcessBuilder("bash", "-lc", cmd).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().readText().trim()
            p.waitFor()
            if (out.isBlank() || !Path.of(out).toFile().exists()) null else Path.of(out)
        }.getOrNull()
    }
}
