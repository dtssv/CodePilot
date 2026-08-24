package io.codepilot.harness.skill

/**
 * Parsed SKILL.md file content.
 *
 * Sunk from backend/codePilot-core/.../skill/SkillInfo.java. The original is a
 * Jackson-annotated record with a hand-rolled frontmatter parser; here we
 * keep the same frontmatter parsing logic (no dependency on a YAML library).
 *
 * Frontmatter format:
 * ```
 * ---
 * name: my-skill
 * description: A short description
 * hidden: true
 * ---
 * <body>
 * ```
 */
data class SkillInfo(
    val name: String,
    val description: String,
    val location: String,
    val content: String,
    val hidden: Boolean = false,
) {
    /** Format for injection into the system prompt. */
    fun toPromptSection(): String = buildString {
        append("## Skill: ").append(name).append("\n\n")
        append(content).append("\n\n")
    }

    companion object {
        /**
         * Parse a SKILL.md file into a SkillInfo. Supports frontmatter with
         * name, description, hidden fields. If no frontmatter, uses filename
         * as name and first line as description.
         */
        fun parse(content: String, location: String): SkillInfo {
            var name: String? = null
            var description: String? = null
            var hidden = false
            var body = content

            if (content.startsWith("---")) {
                val end = content.indexOf("---", 3)
                if (end > 0) {
                    val frontmatter = content.substring(3, end).trim()
                    body = content.substring(end + 3).trim()
                    for (line in frontmatter.split("\n")) {
                        val l = line.trim()
                        when {
                            l.startsWith("name:") -> name = l.substring(5).trim()
                            l.startsWith("description:") -> description = l.substring(12).trim()
                            l.startsWith("hidden:") -> hidden = l.substring(7).trim().toBooleanStrictOrNull() ?: false
                        }
                    }
                }
            }

            if (name.isNullOrBlank()) {
                name = location.substringAfterLast('/').replace(".md", "").replace("SKILL", "").trim()
                if (name.isBlank()) name = "unnamed-skill"
            }
            if (description.isNullOrBlank()) {
                description = body.lines()
                    .map { it.trim() }
                    .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
                    ?.let { if (it.length > 200) it.take(200) + "..." else it }
                    ?: "Skill: $name"
            }
            return SkillInfo(name, description, location, body, hidden)
        }
    }
}
