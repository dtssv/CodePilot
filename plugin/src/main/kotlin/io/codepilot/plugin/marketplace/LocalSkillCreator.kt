package io.codepilot.plugin.marketplace

import com.intellij.openapi.project.Project

/**
 * Creates a minimal local skill from form fields (same YAML shape as [NewSkillPanel]).
 */
object LocalSkillCreator {
    fun create(
        project: Project,
        id: String,
        version: String,
        title: String,
        scope: LocalMarketplaceStore.Scope,
        language: String?,
        action: String?,
        prompt: String,
    ): Result<Unit> =
        runCatching {
            require(id.isNotBlank() && version.isNotBlank() && prompt.isNotBlank()) {
                "id, version and prompt are required."
            }
            val yaml =
                buildYaml(
                    id.trim(),
                    version.trim(),
                    title.trim().ifEmpty { id.trim() },
                    scope.value,
                    prompt,
                    language?.trim()?.ifEmpty { null },
                    action?.trim()?.ifEmpty { null },
                )
            LocalMarketplaceStore.getInstance().installSkill(
                scope,
                project,
                id.trim(),
                version.trim(),
                LocalMarketplaceStore.Source.BUILTIN_IDE,
                yaml,
            )
        }

    fun buildYaml(
        id: String,
        version: String,
        title: String,
        scope: String,
        prompt: String,
        language: String?,
        action: String?,
    ): String =
        buildString {
            appendLine("id: $id")
            appendLine("version: $version")
            appendLine("title: \"${title.replace("\"", "\\\"")}\"")
            appendLine("source: user")
            appendLine("scope: $scope")
            if (!language.isNullOrBlank() || !action.isNullOrBlank()) {
                appendLine("triggers:")
                appendLine("  any:")
                language?.let { appendLine("    - language: [$it]") }
                action?.let { appendLine("    - action: [$it]") }
            }
            appendLine("systemPrompt: |")
            prompt.lineSequence().forEach { appendLine("  $it") }
        }
}
