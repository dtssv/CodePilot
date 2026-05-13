package io.codepilot.plugin.context

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.*
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.PsiShortNamesCache
import io.codepilot.plugin.indexer.IndexScheduler
import io.codepilot.plugin.indexer.LocalSearchEngine
import io.codepilot.plugin.tools.ShellExecutor
import java.nio.charset.StandardCharsets

/**
 * Provides @-reference resolution for the chat input.
 * Supports:
 *   @file — fuzzy match file names → content/outline
 *   @folder — directory name → all file outlines
 *   @symbol — class/method name → definition code
 *   @git — git diff / git log → command output
 *   @codebase — semantic search over the entire project
 *   @terminal — last terminal output (placeholder)
 *   @web — URL fetch (delegated to backend)
 *   @docs — local docs directory search
 *
 * All lookups are read-only and non-blocking (use ReadAction where needed).
 */
@Service(Service.Level.PROJECT)
class AtReferenceProvider(
    private val project: Project,
) {
    private val log = Logger.getInstance(AtReferenceProvider::class.java)

    /** Represents a single @-reference result ready to be sent as context. */
    data class ReferenceResult(
        val type: String, // file, folder, symbol, git, codebase, web, docs, terminal
        val display: String, // what to show in the chip
        val path: String? = null, // file path if applicable
        val range: IntRange? = null, // line range if applicable
        val content: String = "", // resolved content
        val symbols: List<String> = emptyList(),
    )

    // ═══════════════════════════════════════════════════════════════
    // Autocomplete suggestions (for the dropdown when user types @)
    // ═══════════════════════════════════════════════════════════════

    data class Suggestion(
        val type: String,
        val label: String,
        val detail: String = "",
        val path: String? = null,
    )

    /** Get autocomplete suggestions for a partial query after @. */
    fun suggest(
        query: String,
        limit: Int = 15,
    ): List<Suggestion> {
        if (query.isBlank()) {
            return listOf(
                Suggestion("file", "@file", "Search files by name"),
                Suggestion("folder", "@folder", "Search folders"),
                Suggestion("symbol", "@symbol", "Search classes/methods"),
                Suggestion("git", "@git", "Git diff or log"),
                Suggestion("codebase", "@codebase", "Semantic codebase search"),
                Suggestion("docs", "@docs", "Search docs/ directory"),
                Suggestion("web", "@web", "Fetch URL content"),
                Suggestion("terminal", "@terminal", "Recent terminal output"),
            )
        }

        val parts = query.split(" ", limit = 2)
        val prefix = parts[0].lowercase()
        val subQuery = parts.getOrElse(1) { "" }

        return when {
            prefix == "file" || (!prefix.startsWith("f") && query.length > 0 && "file".startsWith(prefix)) -> {
                searchFiles(subQuery, limit)
            }
            prefix == "folder" || ("folder".startsWith(prefix) && prefix.isNotEmpty()) -> searchFolders(subQuery, limit)
            prefix == "symbol" || ("symbol".startsWith(prefix) && prefix.isNotEmpty()) -> searchSymbols(subQuery, limit)
            prefix == "git" || ("git".startsWith(prefix) && prefix.isNotEmpty()) ->
                listOf(
                    Suggestion("git", "@git diff", "Unstaged changes"),
                    Suggestion("git", "@git diff --staged", "Staged changes"),
                    Suggestion("git", "@git log --oneline -10", "Recent commits"),
                )
            prefix == "codebase" || ("codebase".startsWith(prefix) && prefix.isNotEmpty()) -> listOf(Suggestion("codebase", "@codebase $subQuery", "Semantic search"))
            prefix == "docs" || ("docs".startsWith(prefix) && prefix.isNotEmpty()) -> searchDocs(subQuery, limit)
            prefix == "web" || ("web".startsWith(prefix) && prefix.isNotEmpty()) -> listOf(Suggestion("web", "@web $subQuery", "Fetch URL content"))
            prefix == "terminal" || ("terminal".startsWith(prefix) && prefix.isNotEmpty()) -> listOf(Suggestion("terminal", "@terminal", "Recent terminal output"))
            else -> searchFiles(query, limit) + searchSymbols(query, limit / 2)
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Full resolution (when user selects a suggestion)
    // ═══════════════════════════════════════════════════════════════

    /** Resolve a @-reference to full content. */
    fun resolve(
        type: String,
        value: String,
    ): ReferenceResult? =
        when (type) {
            "file" -> resolveFile(value)
            "folder" -> resolveFolder(value)
            "symbol" -> resolveSymbol(value)
            "git" -> resolveGit(value)
            "codebase" -> resolveCodebase(value)
            "docs" -> resolveDocs(value)
            "web" -> resolveWeb(value)
            "terminal" -> resolveTerminal(value)
            else -> null
        }

    // ─── File ───────────────────────────────────────────────────────

    private fun searchFiles(
        query: String,
        limit: Int,
    ): List<Suggestion> {
        // If query is blank, show recently used / project root files as hints
        if (query.isBlank()) {
            val projectBase = project.basePath ?: return emptyList()
            val root = VirtualFileManager.getInstance().findFileByUrl("file://$projectBase") ?: return emptyList()
            return root.children
                .filter { !it.isDirectory && it.length < 100_000 && !it.name.startsWith(".") }
                .take(limit)
                .map { vf ->
                    val rel = vf.path.removePrefix(projectBase).trimStart('/')
                    Suggestion("file", "@file $rel", "${vf.length / 1024}KB", rel)
                }
        }
        return ReadAction.compute<List<Suggestion>, Throwable> {
            val scope = GlobalSearchScope.projectScope(project)
            // Try exact name match first, then fuzzy
            val ext = query.substringAfterLast('.', "")
            val namePart = query.substringBeforeLast('.')
            val files = if (ext.isNotBlank()) {
                FilenameIndex
                    .getAllFilesByExt(project, ext, scope)
                    .filter { it.name.lowercase().contains(query.lowercase()) }
                    .take(limit)
            } else {
                // No extension — search by name across common extensions
                val commonExts = listOf("kt", "java", "ts", "tsx", "js", "jsx", "py", "go", "rs", "css", "html", "json", "yaml", "yml", "md", "xml", "gradle", "properties")
                commonExts.flatMap { e ->
                    FilenameIndex.getAllFilesByExt(project, e, scope)
                        .filter { it.name.lowercase().contains(query.lowercase()) }
                }.take(limit)
            }
            files.map { vf ->
                val rel = vf.path.removePrefix(project.basePath ?: "").trimStart('/')
                Suggestion("file", "@file $rel", "${vf.length / 1024}KB", rel)
            }
        } ?: emptyList()
    }

    private fun resolveFile(path: String): ReferenceResult? {
        val projectBase = project.basePath ?: return null
        val vf = VirtualFileManager.getInstance().findFileByUrl("file://$projectBase/$path") ?: return null
        val content =
            try {
                val raw = vf.contentsToByteArray()
                if (raw.size > 100_000) {
                    // Too large: return outline instead
                    val text = String(raw, StandardCharsets.UTF_8)
                    val lines = text.lines()
                    "// File: $path (${lines.size} lines, showing outline)\n" +
                        lines.take(50).joinToString("\n") + "\n// ... (truncated)"
                } else {
                    String(raw, StandardCharsets.UTF_8)
                }
            } catch (_: Exception) {
                return null
            }

        return ReferenceResult(
            type = "file",
            display = "@file $path",
            path = path,
            content = content,
        )
    }

    // ─── Folder ─────────────────────────────────────────────────────

    private fun searchFolders(
        query: String,
        limit: Int,
    ): List<Suggestion> {
        val projectRoot =
            project.basePath?.let { VirtualFileManager.getInstance().findFileByUrl("file://$it") }
                ?: return emptyList()
        if (query.isBlank()) {
            // Show top-level directories as hints
            return projectRoot.children
                .filter { it.isDirectory && !it.name.startsWith(".") && it.name != "node_modules" && it.name != "build" }
                .take(limit)
                .map { dir ->
                    val rel = dir.path.removePrefix(project.basePath ?: "").trimStart('/')
                    Suggestion("folder", "@folder $rel", "directory", rel)
                }
        }
        val results = mutableListOf<Suggestion>()
        VfsUtilCore.iterateChildrenRecursively(projectRoot, { it.isDirectory && it.name != ".git" && it.name != "node_modules" }) { dir ->
            if (dir.isDirectory && dir.name.lowercase().contains(query.lowercase())) {
                val rel = dir.path.removePrefix(project.basePath ?: "").trimStart('/')
                if (rel.isNotBlank()) results.add(Suggestion("folder", "@folder $rel", "directory", rel))
            }
            results.size < limit
        }
        return results.take(limit)
    }

    private fun resolveFolder(path: String): ReferenceResult? {
        val projectBase = project.basePath ?: return null
        val dir = VirtualFileManager.getInstance().findFileByUrl("file://$projectBase/$path") ?: return null
        if (!dir.isDirectory) return null

        val outlines = mutableListOf<String>()
        dir.children.filter { !it.isDirectory && it.length < 100_000 }.take(20).forEach { vf ->
            val rel = vf.path.removePrefix(projectBase).trimStart('/')
            outlines.add("// $rel")
        }

        return ReferenceResult(
            type = "folder",
            display = "@folder $path",
            path = path,
            content = outlines.joinToString("\n"),
        )
    }

    // ─── Symbol ─────────────────────────────────────────────────────

    private fun searchSymbols(
        query: String,
        limit: Int,
    ): List<Suggestion> {
        if (query.isBlank()) return emptyList()
        return ReadAction.compute<List<Suggestion>, Throwable> {
            val cache = PsiShortNamesCache.getInstance(project)
            val scope = GlobalSearchScope.projectScope(project)
            val results = mutableListOf<Suggestion>()

            // Search classes
            cache.getClassesByName(query, scope).take(limit / 2).forEach { cls ->
                val path =
                    cls.containingFile
                        ?.virtualFile
                        ?.path
                        ?.removePrefix(project.basePath ?: "")
                        ?.trimStart('/') ?: ""
                results.add(Suggestion("symbol", "@symbol ${cls.qualifiedName ?: cls.name}", path, path))
            }

            // Search methods
            cache.getMethodsByName(query, scope).take(limit / 2).forEach { method ->
                val cls = method.containingClass?.name ?: ""
                val path =
                    method.containingFile
                        ?.virtualFile
                        ?.path
                        ?.removePrefix(project.basePath ?: "")
                        ?.trimStart('/') ?: ""
                results.add(Suggestion("symbol", "@symbol $cls.${method.name}", path, path))
            }

            results
        } ?: emptyList()
    }

    private fun resolveSymbol(name: String): ReferenceResult? {
        return ReadAction.compute<ReferenceResult?, Throwable> {
            val scope = GlobalSearchScope.projectScope(project)
            val cache = PsiShortNamesCache.getInstance(project)

            // Try class first
            val simpleName = name.substringAfterLast('.')
            val classes = cache.getClassesByName(simpleName, scope)
            val cls = classes.firstOrNull { (it.qualifiedName ?: it.name) == name || it.name == name }
            if (cls != null) {
                val vf = cls.containingFile?.virtualFile
                val path = vf?.path?.removePrefix(project.basePath ?: "")?.trimStart('/') ?: ""
                return@compute ReferenceResult(
                    type = "symbol",
                    display = "@symbol $name",
                    path = path,
                    content = cls.text ?: "",
                    symbols = listOf(cls.qualifiedName ?: cls.name ?: name),
                )
            }

            // Try method
            val methods = cache.getMethodsByName(simpleName, scope)
            val method = methods.firstOrNull()
            if (method != null) {
                val vf = method.containingFile?.virtualFile
                val path = vf?.path?.removePrefix(project.basePath ?: "")?.trimStart('/') ?: ""
                return@compute ReferenceResult(
                    type = "symbol",
                    display = "@symbol $name",
                    path = path,
                    content = method.text ?: "",
                    symbols = listOf("${method.containingClass?.name}.${method.name}"),
                )
            }
            null
        }
    }

    // ─── Git ────────────────────────────────────────────────────────

    private fun resolveGit(command: String): ReferenceResult? {
        val gitCmd = if (command.startsWith("git ")) command else "git $command"
        val result =
            try {
                val args =
                    com.fasterxml.jackson.databind
                        .ObjectMapper()
                        .createObjectNode()
                args.put("command", gitCmd)
                args.put("cwd", project.basePath ?: ".")
                args.put("timeoutMs", 10000)
                val execResult = ShellExecutor(project).execute(args)
                execResult["stdout"]?.toString() ?: execResult["stderr"]?.toString() ?: ""
            } catch (e: Exception) {
                "Error: ${e.message}"
            }
        return ReferenceResult(
            type = "git",
            display = "@git $command",
            content = result.take(10000), // Limit output
        )
    }

    // ─── Codebase (semantic search) ──────────────────────────────────

    private fun resolveCodebase(query: String): ReferenceResult? {
        val scheduler = IndexScheduler.getInstance(project)
        val hits = scheduler.search(query, topK = 10)
        if (hits.isEmpty()) {
            return ReferenceResult(type = "codebase", display = "@codebase $query", content = "(no results)")
        }
        val content =
            hits.joinToString("\n---\n") { hit: LocalSearchEngine.SearchHit ->
                "// ${hit.path}:${hit.startLine}-${hit.endLine} (score: ${"%.2f".format(hit.score)})\n${hit.snippet}"
            }
        return ReferenceResult(
            type = "codebase",
            display = "@codebase $query",
            content = content,
            symbols = hits.flatMap { it: LocalSearchEngine.SearchHit -> it.symbols }.distinct(),
        )
    }

    // ─── Docs ───────────────────────────────────────────────────────

    private fun searchDocs(
        query: String,
        limit: Int,
    ): List<Suggestion> {
        val projectBase = project.basePath ?: return emptyList()
        val docsDir = VirtualFileManager.getInstance().findFileByUrl("file://$projectBase/docs") ?: return emptyList()
        val results = mutableListOf<Suggestion>()
        docsDir.children
            .filter { !it.isDirectory && it.name.lowercase().contains(query.lowercase()) }
            .take(limit)
            .forEach { vf ->
                val rel = vf.path.removePrefix(projectBase).trimStart('/')
                results.add(Suggestion("docs", "@docs $rel", vf.name, rel))
            }
        return results
    }

    private fun resolveDocs(path: String): ReferenceResult? {
        val projectBase = project.basePath ?: return null
        val vf = VirtualFileManager.getInstance().findFileByUrl("file://$projectBase/$path") ?: return null
        val content =
            try {
                String(vf.contentsToByteArray(), StandardCharsets.UTF_8).take(20000)
            } catch (_: Exception) {
                return null
            }
        return ReferenceResult(type = "docs", display = "@docs $path", path = path, content = content)
    }

    // ─── Web ───────────────────────────────────────────────────────

    /**
     * Resolve @web reference by fetching URL content through the backend proxy.
     * The backend handles the actual HTTP fetch to avoid CORS and security issues.
     * Returns cleaned text content (stripped of HTML tags) limited to 15KB.
     */
    private fun resolveWeb(url: String): ReferenceResult? {
        if (url.isBlank()) return null

        // Validate URL format
        val normalizedUrl =
            when {
                url.startsWith("http://") || url.startsWith("https://") -> url
                else -> "https://$url"
            }

        return try {
            val http =
                io.codepilot.plugin.transport.HttpClientService
                    .getInstance()
            val request =
                okhttp3.Request
                    .Builder()
                    .url(
                        http.client().let { client ->
                            val settings =
                                io.codepilot.plugin.settings.CodePilotSettings
                                    .getInstance()
                            val baseUrl = settings.state.backendBaseUrl.trimEnd('/')
                            "$baseUrl/v1/tools/web-fetch?url=${java.net.URLEncoder.encode(normalizedUrl, "UTF-8")}"
                        },
                    ).get()
                    .header("Accept", "application/json")
                    .build()

            val response = http.client().newCall(request).execute()
            if (!response.isSuccessful) {
                log.warn("@web fetch failed for $normalizedUrl: HTTP ${response.code}")
                return ReferenceResult(type = "web", display = "@web $url", content = "(Failed to fetch: HTTP ${response.code})")
            }

            val body = response.body?.string() ?: return null
            val mapper =
                com.fasterxml.jackson.module.kotlin
                    .jacksonObjectMapper()
            val tree = mapper.readTree(body)
            val title = tree.path("title").asText(url)
            val content = tree.path("content").asText("").take(15000)

            if (content.isBlank()) {
                return ReferenceResult(type = "web", display = "@web $url", content = "(No content retrieved from $normalizedUrl)")
            }

            val header = "--- @web: $title ($normalizedUrl) ---\n"
            ReferenceResult(type = "web", display = "@web $title", content = header + content)
        } catch (e: Exception) {
            log.warn("@web fetch error for $normalizedUrl: ${e.message}")
            ReferenceResult(type = "web", display = "@web $url", content = "(Error fetching $normalizedUrl: ${e.message})")
        }
    }

    // ─── Terminal ──────────────────────────────────────────────────

    /**
     * Resolve @terminal reference by capturing recent terminal output.
     * Returns the last N lines from the persistent terminal session.
     */
    private fun resolveTerminal(value: String): ReferenceResult? {
        val terminalManager =
            io.codepilot.plugin.tools.TerminalSessionManager
                .getInstance(project)
        val output = terminalManager.getLastOutput(project, maxLines = 100)
        if (output.isBlank()) {
            return ReferenceResult(type = "terminal", display = "@terminal", content = "(No recent terminal output available)")
        }
        val header = "--- @terminal: recent output ---\n"
        return ReferenceResult(type = "terminal", display = "@terminal", content = header + output.take(10000))
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): AtReferenceProvider = project.service()
    }
}
