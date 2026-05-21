package io.codepilot.plugin.marketplace

/**
 * Lightweight parser for marketplace {@code skill.yaml} files.
 * Extracts triggers metadata and system prompt without pulling in a YAML library.
 */
object SkillYamlParser {

    data class Parsed(
        val systemPrompt: String,
        val category: String?,
        val priority: Int,
        val triggerLanguages: List<String>,
        val triggerGlobs: List<String>,
        val triggerKeywords: List<String>,
    )

    fun parse(yaml: String): Parsed {
        val systemPrompt = extractBlock(yaml, "systemPrompt:")
        val category = regexField(yaml, "category:\\s*(\\S+)")
        val priority = regexField(yaml, "priority:\\s*(\\d+)")?.toIntOrNull() ?: 50
        val languages = mutableListOf<String>()
        val globs = mutableListOf<String>()
        val keywords = mutableListOf<String>()
        regexList(yaml, "language:\\s*\\[([^\\]]*)\\]")?.let { languages.addAll(splitList(it)) }
        regexList(yaml, "fileGlob:\\s*\\[([^\\]]*)\\]")?.let { globs.addAll(splitList(it)) }
        regexList(yaml, "keywords:\\s*\\[([^\\]]*)\\]")?.let { keywords.addAll(splitList(it)) }
        return Parsed(systemPrompt, category, priority, languages, globs, keywords)
    }

    fun triggersPayload(parsed: Parsed): Map<String, Any?> {
        val anyGroups = mutableListOf<Map<String, Any?>>()
        if (parsed.triggerLanguages.isNotEmpty()) {
            anyGroups.add(mapOf("language" to parsed.triggerLanguages))
        }
        if (parsed.triggerGlobs.isNotEmpty()) {
            anyGroups.add(mapOf("fileGlob" to parsed.triggerGlobs))
        }
        if (parsed.triggerKeywords.isNotEmpty()) {
            anyGroups.add(mapOf("keywords" to parsed.triggerKeywords))
        }
        return if (anyGroups.isEmpty()) mapOf() else mapOf("any" to anyGroups)
    }

    private fun extractBlock(yaml: String, key: String): String {
        val idx = yaml.indexOf(key)
        if (idx < 0) return ""
        val after = yaml.substring(idx + key.length).trimStart()
        if (!after.startsWith("|")) {
            return after.lineSequence().firstOrNull()?.trim() ?: ""
        }
        val lines = after.lines().drop(1)
        val content = StringBuilder()
        for (line in lines) {
            if (line.isNotBlank() && !line.startsWith(" ") && !line.startsWith("\t")) break
            content.appendLine(line.removePrefix("  ").removePrefix("\t"))
        }
        return content.toString().trim()
    }

    private fun regexField(text: String, pattern: String): String? =
        Regex(pattern, RegexOption.MULTILINE).find(text)?.groupValues?.getOrNull(1)

    private fun regexList(text: String, pattern: String): String? =
        Regex(pattern, RegexOption.MULTILINE).find(text)?.groupValues?.getOrNull(1)

    private fun splitList(raw: String): List<String> =
        raw.split(",").map { it.trim().removeSurrounding("\"").removeSurrounding("'") }.filter { it.isNotBlank() }
}
