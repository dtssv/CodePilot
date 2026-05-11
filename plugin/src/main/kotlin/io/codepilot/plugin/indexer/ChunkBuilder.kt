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
class ChunkBuilder(
    private val project: Project,
) {
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

        val raw =
            try {
                vf.contentsToByteArray()
            } catch (_: Exception) {
                return emptyList()
            }
        val text = String(raw, StandardCharsets.UTF_8)
        if (text.isBlank()) return emptyList()

        val relativePath = vf.path.removePrefix(project.basePath ?: "").trimStart('/')
        val language = vf.fileType.name.lowercase()
        val lines = text.lines()

        // Try Markdown-based splitting for .md/.rst/.mdx files
        val mdChunks = tryMarkdownSplit(relativePath, language, lines, text)
        if (mdChunks.isNotEmpty()) return mdChunks

        // Try PSI-based splitting first
        val psiChunks = tryPsiSplit(vf, relativePath, language, lines)
        if (psiChunks.isNotEmpty()) return psiChunks

        // Fallback to sliding window
        return slidingWindowSplit(relativePath, language, lines, text)
    }

    private fun tryPsiSplit(
        vf: VirtualFile,
        path: String,
        language: String,
        lines: List<String>,
    ): List<Chunk> {
        val psiFile =
            ReadAction.compute<PsiFile?, Throwable> {
                PsiManager.getInstance(project).findFile(vf)
            } ?: return emptyList()

        val boundaries =
            ReadAction.compute<List<PsiBoundary>, Throwable> {
                val doc = PsiDocumentManager.getInstance(project).getDocument(psiFile) ?: return@compute emptyList()
                val result = mutableListOf<PsiBoundary>()

                PsiTreeUtil.processElements(psiFile) { element ->
                    val (isTarget, symbolName) =
                        when (element) {
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
            val chunkLines =
                lines.subList(
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
                ),
            )
        }

        // If PSI boundaries don't cover enough of the file, fill gaps with sliding window
        if (chunks.isEmpty()) return emptyList()
        return chunks
    }

    private fun slidingWindowSplit(
        path: String,
        language: String,
        lines: List<String>,
        fullText: String,
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
                    ),
                )
            }

            start = end - OVERLAP_LINES
            if (start >= lines.size - MIN_CHUNK_LINES) break
        }

        return chunks
    }

    // ─── Markdown Splitting ────────────────────────────────────────────

    /**
     * Split Markdown / reStructuredText / MDX files by heading boundaries.
     *
     * Strategy:
     * 1. Extract frontmatter (YAML between --- delimiters) as metadata
     * 2. Split by ATX headings (# ## ### etc.) or RST section markers
     * 3. Each section becomes a chunk with heading as primary symbol
     * 4. Sections smaller than [MIN_CHUNK_LINES] are merged with the previous
     * 5. Sections larger than [MAX_CHUNK_LINES] are further split by paragraph
     */
    private fun tryMarkdownSplit(
        path: String,
        language: String,
        lines: List<String>,
        fullText: String,
    ): List<Chunk> {
        val ext = path.substringAfterLast('.', "")
        if (ext !in setOf("md", "mdx", "rst", "markdown")) return emptyList()

        // 1. Extract frontmatter metadata
        val frontmatter = extractFrontmatter(lines)
        val contentStartLine =
            if (frontmatter != null) {
                // Find the second --- delimiter
                val secondDelim = lines.drop(1).indexOfFirst { it.trim() == "---" }
                if (secondDelim >= 0) secondDelim + 2 else 0
            } else {
                0
            }

        val contentLines = lines.drop(contentStartLine)

        // 2. Find heading boundaries
        val headingBoundaries = mutableListOf<HeadingBoundary>()
        for ((i, line) in contentLines.withIndex()) {
            val atxMatch = Regex("^(#{1,6})\\s+(.+)$").find(line)
            if (atxMatch != null) {
                val level = atxMatch.groupValues[1].length
                val title = atxMatch.groupValues[2].trim()
                headingBoundaries.add(HeadingBoundary(i, level, title))
                continue
            }
            // RST section detection: next line is === or --- underline
            if (i + 1 < contentLines.size) {
                val nextLine = contentLines[i + 1].trim()
                if (nextLine.isNotEmpty() && nextLine.all { it == '=' || it == '-' }) {
                    val level = if (nextLine.all { it == '=' }) 1 else 2
                    headingBoundaries.add(HeadingBoundary(i, level, line.trim()))
                }
            }
        }

        // 3. Build chunks from heading sections
        val chunks = mutableListOf<Chunk>()
        val fmImports = frontmatter?.let { listOf("frontmatter:$it") } ?: emptyList()

        if (headingBoundaries.isEmpty()) {
            // No headings — treat entire file as one chunk
            if (contentLines.size >= MIN_CHUNK_LINES) {
                val content = contentLines.joinToString("\n")
                chunks.add(
                    Chunk(
                        path = path,
                        language = language,
                        startLine = contentStartLine + 1,
                        endLine = lines.size,
                        content = content,
                        symbols = extractMdSymbols(content),
                        imports = fmImports,
                        contentHash = sha256Hex(content.toByteArray(StandardCharsets.UTF_8)),
                    ),
                )
            }
            return chunks
        }

        // Add a virtual boundary at the end
        val allBoundaries = headingBoundaries + HeadingBoundary(contentLines.size, 0, "")

        for (i in 0 until allBoundaries.size - 1) {
            val start = allBoundaries[i].lineIndex
            val end = allBoundaries[i + 1].lineIndex
            val sectionLines = contentLines.subList(start, end.coerceAtMost(contentLines.size))
            if (sectionLines.size < MIN_CHUNK_LINES && chunks.isNotEmpty()) {
                // Merge small section into previous chunk
                val prev = chunks.last()
                val mergedContent = prev.content + "\n" + sectionLines.joinToString("\n")
                chunks[chunks.lastIndex] =
                    prev.copy(
                        endLine = contentStartLine + start + sectionLines.size,
                        content = mergedContent,
                        symbols = prev.symbols + listOf(allBoundaries[i].title),
                        contentHash = sha256Hex(mergedContent.toByteArray(StandardCharsets.UTF_8)),
                    )
                continue
            }

            val content = sectionLines.joinToString("\n")
            if (content.isBlank()) continue

            // If section exceeds max chunk size, split by paragraph
            if (sectionLines.size > MAX_CHUNK_LINES) {
                val subChunks =
                    splitMarkdownByParagraph(
                        path,
                        language,
                        contentStartLine + start + 1,
                        sectionLines,
                        fmImports,
                    )
                chunks.addAll(subChunks)
            } else {
                chunks.add(
                    Chunk(
                        path = path,
                        language = language,
                        startLine = contentStartLine + start + 1,
                        endLine = contentStartLine + start + sectionLines.size,
                        content = content,
                        symbols = listOf(allBoundaries[i].title) + extractMdSymbols(content),
                        imports = fmImports,
                        contentHash = sha256Hex(content.toByteArray(StandardCharsets.UTF_8)),
                    ),
                )
            }
        }

        return chunks
    }

    /**
     * Extract YAML frontmatter (content between opening --- delimiters).
     */
    private fun extractFrontmatter(lines: List<String>): String? {
        if (lines.isEmpty() || lines[0].trim() != "---") return null
        val endIdx = lines.drop(1).indexOfFirst { it.trim() == "---" }
        if (endIdx < 0) return null
        return lines.subList(1, endIdx + 1).joinToString("\n")
    }

    /**
     * Extract symbol-like references from Markdown content:
     * - Code block language tags (```java → symbol:code:java)
     * - Link references ([label]: url)
     * - Inline code (`symbol`)
     */
    private fun extractMdSymbols(content: String): List<String> {
        val symbols = mutableListOf<String>()
        // Code block language tags
        Regex("```(\\w+)").findAll(content).forEach { m ->
            symbols.add("code:${m.groupValues[1]}")
        }
        // Link references
        Regex("^\\[(.+?)\\]:", RegexOption.MULTILINE).findAll(content).forEach { m ->
            symbols.add("ref:${m.groupValues[1]}")
        }
        return symbols.distinct().take(10)
    }

    /**
     * Split a large Markdown section by paragraph boundaries (blank lines).
     */
    private fun splitMarkdownByParagraph(
        path: String,
        language: String,
        startLine: Int,
        lines: List<String>,
        imports: List<String>,
    ): List<Chunk> {
        val chunks = mutableListOf<Chunk>()
        var currentStart = 0

        for (i in lines.indices) {
            val currentContent = lines.subList(currentStart, i + 1).joinToString("\n")
            if (i + 1 == lines.size || (lines[i].isBlank() && currentContent.lines().size >= MIN_CHUNK_LINES)) {
                if (currentContent.lines().size >= MIN_CHUNK_LINES) {
                    chunks.add(
                        Chunk(
                            path = path,
                            language = language,
                            startLine = startLine + currentStart,
                            endLine = startLine + i,
                            content = currentContent,
                            symbols = extractMdSymbols(currentContent),
                            imports = imports,
                            contentHash = sha256Hex(currentContent.toByteArray(StandardCharsets.UTF_8)),
                        ),
                    )
                }
                currentStart = i + 1
            }
        }
        return chunks
    }

    private data class HeadingBoundary(
        val lineIndex: Int,
        val level: Int,
        val title: String,
    )

    private fun extractImports(lines: List<String>): List<String> =
        lines
            .take(60)
            .filter { it.trimStart().startsWith("import ") || it.trimStart().startsWith("from ") || it.trimStart().startsWith("require(") }
            .map { it.trim() }
            .take(20)

    private fun extractSimpleSymbols(content: String): List<String> {
        val patterns =
            listOf(
                Regex("""(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|enum|object)\s+(\w+)"""),
                Regex("""(?:public|private|protected|internal)?\s*(?:static\s+)?(?:fun|def|function)\s+(\w+)"""),
                Regex("""(?:export\s+)?(?:const|let|var|function)\s+(\w+)"""),
                Regex("""func\s+(\w+)"""),
            )
        return patterns
            .flatMap { pattern ->
                pattern.findAll(content).map { it.groupValues[1] }.toList()
            }.distinct()
            .take(10)
    }

    private data class PsiBoundary(
        val startLine: Int,
        val endLine: Int,
        val symbolName: String,
    )
}
