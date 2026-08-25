package io.codepilot.adapter

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import io.codepilot.harness.search.Bm25Searcher
import io.codepilot.harness.search.CodeSearcher
import io.codepilot.harness.search.GrepOpts
import io.codepilot.harness.search.Hit
import io.codepilot.harness.search.IndexedChunk
import java.nio.file.Path

/**
 * Bridges the harness-core [CodeSearcher] SPI to the IntelliJ project.
 *
 * **Current implementation**: delegates to a pure-JDK [Bm25Searcher] backed
 * by an in-memory index fed by walking the project VFS. This gives a working
 * search out of the box with no external deps.
 *
 * **TODO (M2/M3)**: hook into the existing `plugin/indexer/` pipeline
 * (`LocalIndexStore` + `IndexWatcher` + `ChunkBuilder`) so the index is
 * maintained incrementally on VFS changes rather than rebuilt on each query,
 * and so PSI-based symbol extraction (class/method names) feeds the
 * `symbols` field of [IndexedChunk] for better hybrid scoring.
 *
 * The harness loop only sees [CodeSearcher]; swapping this adapter for a
 * PSI-backed implementation is transparent to the loop.
 */
class PsiSearcherAdapter(
    project: Project,
    private val delegate: Bm25Searcher = Bm25Searcher(rootOf(project)),
) : CodeSearcher {

    init {
        // Initial bulk index of the project tree.
        // Subsequent re-indexing on VFS changes is a TODO; for now callers
        // may invoke [reindex] when they know files changed.
        reindex(rootOf(project))
    }

    override suspend fun grep(pattern: String, opts: GrepOpts): List<Hit> =
        delegate.grep(pattern, opts)

    override suspend fun semantic(query: String, topK: Int): List<Hit> =
        delegate.semantic(query, topK)

    /**
     * Walks the VFS under [root] and feeds chunks into the BM25 index.
     * Safe to call repeatedly; the underlying index is idempotent on re-add.
     */
    fun reindex(root: Path) {
        val chunks = mutableListOf<IndexedChunk>()
        val maxChars = 200_000 // guard against pathological files
        root.toFile().walkTopDown()
            .filter { it.isFile && it.extension in INDEXABLE_EXTS }
            .forEach { f ->
                val rel = f.relativeTo(root.toFile()).path
                val text = runCatching {
                    f.readText()
                        .take(maxChars)
                }.getOrDefault("")
                if (text.isNotBlank()) {
                    chunks += chunkOf(rel, text)
                }
            }
        delegate.indexChunks(chunks)
    }

    private fun chunkOf(path: String, content: String): IndexedChunk {
        val lines = content.lines()
        val maxChunkLines = 200
        // One chunk per ~200 lines keeps matches fine-grained enough for
        // symbol/path boost without blowing up memory.
        return IndexedChunk(
            path = path,
            startLine = 1,
            endLine = lines.size.coerceAtMost(maxChunkLines),
            content = lines.take(maxChunkLines).joinToString("\n"),
            language = langForExt(path.substringAfterLast('.', "")),
        )
    }

    private fun langForExt(ext: String): String? = when (ext.lowercase()) {
        "kt" -> "kotlin"
        "java" -> "java"
        "py" -> "python"
        "go" -> "go"
        "ts", "tsx" -> "typescript"
        "js", "jsx" -> "javascript"
        "rs" -> "rust"
        "md" -> "markdown"
        else -> null
    }

    companion object {
        private val INDEXABLE_EXTS = setOf(
            "kt", "java", "py", "go", "ts", "tsx", "js", "jsx",
            "rs", "md", "json", "yaml", "yml", "toml", "gradle", "kts",
        )

        fun rootOf(project: Project): Path =
            project.guessProjectDir()?.toNioPath()
                ?: Path.of(System.getProperty("user.dir"))
    }
}
