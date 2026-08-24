package io.codepilot.harness.skill

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Skill manifest — mirrors docs/04-Prompt模板.md §A.
 *
 * Sunk from backend/codePilot-core/.../skill/SkillManifest.java. The Java
 * version is a Jackson-annotated record; here it's a kotlinx-serialization
 * data class so the harness-core module has zero Jackson/Spring dependencies.
 *
 * A Skill is a reusable block of system-prompt content + tool permissions that
 * activates based on workspace signals (languages, frameworks, file globs,
 * keywords). Skills come from:
 *   - project-local:  .codepilot/skills/*.md
 *   - bundled:        shipped with the plugin
 *   - user-injected:  validated by [UserSkillValidator]
 */
@Serializable
data class SkillManifest(
    val id: String,
    val version: String = "1",
    val title: String? = null,
    val source: String = "system",     // "system" | "user"
    val scope: String = "system",      // "system" | "project" | "global"
    val priority: Int = 50,
    val merge: String = "append",      // append | wrap | override
    val triggers: Triggers? = null,
    val permissions: Permissions? = null,
    val audit: Audit? = null,
    val systemPrompt: String = "",
    val category: Category = Category.GENERIC,
) {
    enum class Category { GENERIC, LANG_PRIMARY, LANG_AUX, SCENARIO, ACTION }

    @Serializable
    data class Triggers(
        val all: List<TriggerGroup> = emptyList(),
        val any: List<TriggerGroup> = emptyList(),
    )

    @Serializable
    data class TriggerGroup(
        val language: List<String> = emptyList(),
        val framework: List<String> = emptyList(),
        val action: List<String> = emptyList(),
        val fileGlob: List<String> = emptyList(),
        val keywords: List<String> = emptyList(),
    )

    @Serializable
    data class Permissions(
        val tools: List<String> = emptyList(),
        val risk: List<String> = emptyList(),
    )

    @Serializable
    data class Audit(
        @SerialName("tokensEstimate") val tokensEstimate: Int? = null,
        val tags: List<String> = emptyList(),
    )

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(yamlOrJson: String): SkillManifest {
            // The original accepts YAML; for harness-core we standardize on JSON
            // (the IDE adapter converts YAML → JSON if needed). This keeps the
            // module free of a YAML parser dependency.
            return json.decodeFromString(serializer(), yamlOrJson)
        }
    }
}
