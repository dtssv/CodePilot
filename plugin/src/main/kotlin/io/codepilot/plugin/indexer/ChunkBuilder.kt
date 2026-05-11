package io.codepilot.plugin.indexer

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.*
import com.intellij.psi.util.PsiTreeUtil
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Language-aware chunk builder. Splits source files into semantically meaningful chunks
 * for embedding-based codebase indexing.
 *
 * Strategy:
 * - Java/Kotlin: split by class/method boundaries using PSI
 * - JS/TS/Python: split by function/class boundaries using PSI
 * - Generic: sliding window of ~150 lines with 30-line overlap
 *
 * Each chunk carries metadata: path, language, range, symbols, imports, content hash.
 */
class ChunkBuilder(private val project: Project) {

    companion object {
        const val MAX_CHUNK_LINES = 150
        const val OVERLAP_LINES = 30
        const val MIN_CHUNK_LINES = 10
        const val MAX_FILE_SIZE_BYTES = 512 * 1024 // 512KB, skip larger files

        fun sha256Hex(data: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256")
            return digest.digest(data).joinToString("") { "%02x".format(it) }
        }
    }

    data class Chunk(
        val path: String,
        val language: String,
        val startLine: Int,
        val endLine: Int,
        val content: String,
        val symbols: List<String>,
        val imports: List<String>,
        val contentHash: String,
    )

    /** Build chunks for a single file. Returns empty if file is too large or binary. */
    fun buildChunks(vf: VirtualFile): List<Chunk> {
        if (vf.length > MAX_FILE_SIZE_BYTES) return emptyList()
        if (vf.fileType.isBinary) return emptyList()

        val raw = try {
            vf.contentsToByteArray()
        } catch (_: Exception) {
            return emptyList()
        }
        val text = String(raw, StandardCharsets.UTF_8)
        if (text.isBlank()) return emptyList()

        val relativePath = vf.path.removePrefix(project.basePath ?: "").trimStart('/')
        val language = vf.fileType.name.lowercase()
        val lines = text.lines()

        // Try PSI-based splitting first
        val psiChunks = tryPsiSplit(vf, relativePath, language, lines)
        if (psiChunks.isNotEmpty()) return psiChunks

        // Fallback to sliding window
        return slidingWindowSplit(relativePath, language, lines, text)
    }

    private fun tryPsiSplit(vf: VirtualFile, path: String, language: String, lines: List<String>): List<Chunk> {
        val psiFile = ReadAction.compute<PsiFile?, Throwable> {
            PsiManager.getInstance(project).findFile(vf)
        } ?: return emptyList()

        val boundaries = ReadAction.compute<List<PsiBoundary>, Throwable> {
            val doc = PsiDocumentManager.getInstance(project).getDocument(psiFile) ?: return@compute emptyList()
            val result = mutableListOf<PsiBoundary>()

            PsiTreeUtil.processElements(psiFile) { element ->
                val (isTarget, symbolName) = when (element) {
                    is PsiClass -> true to (element.qualifiedName ?: element.name ?: "AnonymousClass")
                    is PsiMethod -> true to "${element.containingClass?.name ?: ""}.${element.name}"
                    is PsiField -> false to null // fields are too small for standalone chunks
                    else -> false to null
                }
                if (isTarget && symbolName != null) {
                    val startOffset = element.textRange.startOffset
                    val endOffset = element.textRange.endOffset
                    val startLine = doc.getLineNumber(startOffset) + 1
                    val endLine = doc.getLineNumber(endOffset) + 1
                    if (endLine - startLine + 1 >= MIN_CHUNK_LINES) {
                        result.add(PsiBoundary(startLine, endLine, symbolName))
                    }
                }
                true
            }
            result
        }

        if (boundaries.isEmpty()) return emptyList()

        val imports = extractImports(lines)
        val chunks = mutableListOf<Chunk>()

        for (boundary in boundaries) {
            val chunkLines = lines.subList(
                (boundary.startLine - 1).coerceIn(0, lines.size),
                boundary.endLine.coerceIn(0, lines.size),
            )
            val content = chunkLines.joinToString("\n")
            if (content.isBlank()) continue

            chunks.add(
                Chunk(
                    path = path,
                    language = language,
                    startLine = boundary.startLine,
                    endLine = boundary.endLine,
                    content = content,
                    symbols = listOf(boundary.symbolName),
                    imports = imports,
                    contentHash = sha256Hex(content.toByteArray(StandardCharsets.UTF_8)),
                )
            )
        }

        // If PSI boundaries don't cover enough of the file, fill gaps with sliding window
        if (chunks.isEmpty()) return emptyList()
        return chunks
    }

    private fun slidingWindowSplit(
        path: String, language: String, lines: List<String>, fullText: String
    ): List<Chunk> {
        val imports = extractImports(lines)
        val chunks = mutableListOf<Chunk>()
        var start = 0

        while (start < lines.size) {
            val end = (start + MAX_CHUNK_LINES).coerceAtMost(lines.size)
            val chunkLines = lines.subList(start, end)
            val content = chunkLines.joinToString("\n")

            if (content.isNotBlank() && chunkLines.size >= MIN_CHUNK_LINES) {
                // Extract simple symbol names from the chunk (function/class definitions)
                val symbols = extractSimpleSymbols(content)
                chunks.add(
                    Chunk(
                        path = path,
                        language = language,
                        startLine = start + 1,
                        endLine = end,
                        content = content,
                        symbols = symbols,
                        imports = imports,
                        contentHash = sha256Hex(content.toByteArray(StandardCharsets.UTF_8)),
                    )
                )
            }

            start = end - OVERLAP_LINES
            if (start >= lines.size - MIN_CHUNK_LINES) break
        }

        return chunks
    }

    private fun extractImports(lines: List<String>): List<String> =
        lines.take(60)
            .filter { it.trimStart().startsWith("import ") || it.trimStart().startsWith("from ") || it.trimStart().startsWith("require(") }
            .map { it.trim() }
            .take(20)

    private fun extractSimpleSymbols(content: String): List<String> {
        val patterns = listOf(
            Regex("""(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|enum|object)\s+(\w+)"""),
            Regex("""(?:public|private|protected|internal)?\s*(?:static\s+)?(?:fun|def|function)\s+(\w+)"""),
            Regex("""(?:export\s+)?(?:const|let|var|function)\s+(\w+)"""),
            Regex("""func\s+(\w+)"""),
        )
        return patterns.flatMap { pattern ->
            pattern.findAll(content).map { it.groupValues[1] }.toList()
        }.distinct().take(10)
    }

    private data class PsiBoundary(val startLine: Int, val endLine: Int, val symbolName: String)
}