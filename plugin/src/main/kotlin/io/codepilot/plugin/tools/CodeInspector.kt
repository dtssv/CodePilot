package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.Project
import com.intellij.psi.*
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.PsiTreeUtil

/**
 * PSI-based code inspection tools for Gather nodes.
 * Provides:
 *   - code.outline  → class/method/field signatures with line numbers
 *   - code.symbol   → locate a symbol definition by name
 *   - code.usages   → find all references to a symbol
 *
 * All operations are read-only and run inside [ReadAction].
 */
class CodeInspector(
    private val project: Project,
) {
    /**
     * code.outline: returns structured outline (classes, methods, fields) with line numbers.
     */
    fun outline(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val vf = PathGuard.resolve(project, path)
        val psiFile =
            ReadAction.compute<PsiFile?, Throwable> {
                PsiManager.getInstance(project).findFile(vf)
            } ?: return mapOf("path" to path, "items" to emptyList<Any>())

        val items =
            ReadAction.compute<List<Map<String, Any?>>, Throwable> {
                val doc = PsiDocumentManager.getInstance(project).getDocument(psiFile)
                val result = mutableListOf<Map<String, Any?>>()
                PsiTreeUtil.processElements(psiFile) { element ->
                    val entry =
                        when (element) {
                            is PsiClass ->
                                mapOf(
                                    "kind" to "class",
                                    "name" to (element.qualifiedName ?: element.name ?: ""),
                                    "line" to lineOf(doc, element),
                                    "modifiers" to modifiersOf(element),
                                )
                            is PsiMethod ->
                                mapOf(
                                    "kind" to "method",
                                    "name" to element.name,
                                    "signature" to methodSignature(element),
                                    "line" to lineOf(doc, element),
                                    "returnType" to (element.returnType?.presentableText ?: "void"),
                                    "containingClass" to (element.containingClass?.name ?: ""),
                                )
                            is PsiField ->
                                mapOf(
                                    "kind" to "field",
                                    "name" to element.name,
                                    "type" to (element.type.presentableText),
                                    "line" to lineOf(doc, element),
                                    "containingClass" to (element.containingClass?.name ?: ""),
                                )
                            else -> null
                        }
                    if (entry != null) result.add(entry)
                    true
                }
                result
            }

        return mapOf(
            "path" to path,
            "totalItems" to items.size,
            "items" to items.take(200),
        )
    }

    /**
     * code.symbol: locates a symbol definition by qualified or simple name.
     */
    fun findSymbol(args: JsonNode): Map<String, Any?> {
        val symbol = args.path("symbol").asText()
        if (symbol.isBlank()) throw ToolViolation("empty symbol name")
        val scope = GlobalSearchScope.projectScope(project)

        return ReadAction.compute<Map<String, Any?>, Throwable> {
            // Try class first
            val classes =
                JavaPsiFacade
                    .getInstance(project)
                    .findClasses(symbol, scope)
            if (classes.isNotEmpty()) {
                val c = classes.first()
                val vf = c.containingFile?.virtualFile
                val doc = c.containingFile?.let { PsiDocumentManager.getInstance(project).getDocument(it) }
                return@compute mapOf(
                    "found" to true,
                    "kind" to "class",
                    "name" to (c.qualifiedName ?: c.name),
                    "path" to relPath(vf),
                    "line" to lineOf(doc, c),
                )
            }
            // Try method: "ClassName.methodName" or "ClassName#methodName"
            val parts = symbol.split(".", "#", limit = 2)
            if (parts.size == 2) {
                val ownerClasses = JavaPsiFacade.getInstance(project).findClasses(parts[0], scope)
                for (cls in ownerClasses) {
                    val method = cls.findMethodsByName(parts[1], true).firstOrNull()
                    if (method != null) {
                        val vf = method.containingFile?.virtualFile
                        val doc = method.containingFile?.let { PsiDocumentManager.getInstance(project).getDocument(it) }
                        return@compute mapOf(
                            "found" to true,
                            "kind" to "method",
                            "name" to "${cls.qualifiedName}#${method.name}",
                            "signature" to methodSignature(method),
                            "path" to relPath(vf),
                            "line" to lineOf(doc, method),
                        )
                    }
                }
            }
            mapOf("found" to false, "symbol" to symbol)
        }
    }

    /**
     * code.usages: finds all references to a symbol in the project.
     */
    fun findUsages(args: JsonNode): Map<String, Any?> {
        val symbol = args.path("symbol").asText()
        if (symbol.isBlank()) throw ToolViolation("empty symbol name")
        val maxResults = args.path("maxResults").asInt(30).coerceAtMost(100)

        return ReadAction.compute<Map<String, Any?>, Throwable> {
            val target = resolveElement(symbol) ?: return@compute mapOf("found" to false, "symbol" to symbol)
            val refs = ReferencesSearch.search(target, GlobalSearchScope.projectScope(project), false)
            val usages =
                refs.findAll().take(maxResults).map { ref ->
                    val el = ref.element
                    val doc = el.containingFile?.let { PsiDocumentManager.getInstance(project).getDocument(it) }
                    mapOf(
                        "path" to relPath(el.containingFile?.virtualFile),
                        "line" to lineOf(doc, el),
                        "snippet" to el.text.take(120),
                    )
                }
            mapOf("found" to true, "symbol" to symbol, "totalUsages" to usages.size, "usages" to usages)
        }
    }

    private fun resolveElement(symbol: String): PsiElement? {
        val scope = GlobalSearchScope.projectScope(project)
        val classes = JavaPsiFacade.getInstance(project).findClasses(symbol, scope)
        if (classes.isNotEmpty()) return classes.first()
        val parts = symbol.split(".", "#", limit = 2)
        if (parts.size == 2) {
            for (cls in JavaPsiFacade.getInstance(project).findClasses(parts[0], scope)) {
                cls.findMethodsByName(parts[1], true).firstOrNull()?.let { return it }
                cls.findFieldByName(parts[1], true)?.let { return it }
            }
        }
        return null
    }

    private fun lineOf(
        doc: com.intellij.openapi.editor.Document?,
        element: PsiElement,
    ): Int = doc?.getLineNumber(element.textOffset)?.plus(1) ?: 0

    private fun modifiersOf(cls: PsiClass): String = cls.modifierList?.text?.trim() ?: ""

    private fun methodSignature(m: PsiMethod): String {
        val params = m.parameterList.parameters.joinToString(", ") { "${it.type.presentableText} ${it.name}" }
        return "${m.name}($params)"
    }

    private fun relPath(vf: com.intellij.openapi.vfs.VirtualFile?): String {
        if (vf == null) return ""
        val root = PathGuard.projectRoot(project).path
        return vf.path.removePrefix(root).trimStart('/')
    }
}
