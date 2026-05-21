package io.codepilot.plugin.context

/**
 * Expands `\u0001{contextId}\u0001` placeholders using a [contextStore] and [contextRefs],
 * matching the formatting used when sending chat from the JCEF WebUI.
 */
object InlineContextExpander {
    fun expand(
        text: String,
        contextStore: Map<String, String>,
        contextRefs: List<Map<String, Any?>>,
    ): String =
        buildString {
            var remaining = text
            while (true) {
                val start = remaining.indexOf('\u0001')
                if (start < 0) {
                    append(remaining)
                    break
                }
                append(remaining.substring(0, start))
                val end = remaining.indexOf('\u0001', start + 1)
                if (end < 0) {
                    append(remaining.substring(start))
                    break
                }
                val ctxId = remaining.substring(start + 1, end)
                val fullCode = contextStore[ctxId]
                if (fullCode != null) {
                    val ref = contextRefs.find { it["id"] == ctxId }
                    val refType = ref?.get("type") as? String ?: "file"
                    val lang = ref?.get("language") as? String ?: "text"
                    val display = ref?.get("display") as? String ?: "context"
                    val loc =
                        if (ref?.get("startLine") != null) {
                            " :${ref["startLine"]}-${ref["endLine"]}"
                        } else {
                            ""
                        }
                    when (refType) {
                        "web" -> {
                            appendLine("Web Content: $display")
                            appendLine(fullCode)
                        }
                        "git" -> {
                            appendLine("Git Context: $display")
                            appendLine("```")
                            appendLine(fullCode)
                            appendLine("```")
                        }
                        "terminal" -> {
                            appendLine("Terminal Output: $display")
                            appendLine("```")
                            appendLine(fullCode)
                            appendLine("```")
                        }
                        "codebase" -> {
                            appendLine("Codebase Search: $display")
                            appendLine(fullCode)
                        }
                        "symbol" -> {
                            appendLine("Symbol: $display$loc")
                            appendLine("```$lang")
                            appendLine(fullCode)
                            appendLine("```")
                        }
                        else -> {
                            appendLine("Context: $display$loc")
                            appendLine("```$lang")
                            appendLine(fullCode)
                            appendLine("```")
                        }
                    }
                }
                remaining = remaining.substring(end + 1)
            }
        }
}
