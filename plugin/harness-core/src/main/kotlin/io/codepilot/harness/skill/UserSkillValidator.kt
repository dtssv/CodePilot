package io.codepilot.harness.skill

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * The result of skill activation: identifying metadata + the segment text
 * to inject into the system prompt.
 */
data class ActivatedSkill(
    val id: String,
    val version: String = "1",
    val source: String,            // "system" | "user"
    val scope: String,            // "system" | "project" | "global"
    val priority: Int,
    val tokens: Int,
    val permissionsTools: List<String> = emptyList(),
    val systemPrompt: String,
)

/**
 * A user-supplied skill (before validation). Mirrors the relevant subset of
 * the backend's ConversationRunRequest.UserSkill record, so the IDE adapter
 * can populate it without dragging in the whole ConversationRunRequest type.
 */
data class UserSkillInput(
    val id: String,
    val version: String = "1",
    val source: String = "user",
    val scope: String,            // "project" | "global"
    val projectRootHash: String? = null,
    val yaml: String,
    val sha256: String? = null,
)

/**
 * Verifies safety constraints on user-supplied Skills before they are merged
 * into the system.
 *
 * Sunk from backend/codePilot-core/.../skill/UserSkillValidator.java. The
 * original is a Spring `@Service` depending on `TokenMeter` and a custom
 * `CodePilotException`; here we use a simple token-estimate function and
 * throw plain IllegalArgumentException.
 *
 * Rules:
 *   - source must be "user"
 *   - scope must be "project" or "global"
 *   - project-scoped skills require a matching [projectRootHash]
 *   - yaml body must be non-blank
 *   - sha256 (if provided) must match the yaml body
 *   - token estimate (chars/4) must be ≤ [perSkillTokenBudget]
 */
class UserSkillValidator(
    private val perSkillTokenBudget: Int = 600,
) {
    fun validate(
        userSkills: List<UserSkillInput>,
        requestProjectRootHash: String?,
        allowedTools: Set<String>,
    ): List<ActivatedSkill> {
        if (userSkills.isEmpty()) return emptyList()
        return userSkills.map { toActivated(it, requestProjectRootHash, allowedTools) }
    }

    private fun toActivated(s: UserSkillInput, reqRootHash: String?, allowedTools: Set<String>): ActivatedSkill {
        require(s.source.equals("user", ignoreCase = true)) {
            "userSkills[*].source must be 'user'"
        }
        require(s.scope in ALLOWED_SCOPES) {
            "userSkills[*].scope must be 'project' or 'global'"
        }
        if (s.scope == "project") {
            require(!reqRootHash.isNullOrBlank() && reqRootHash.equals(s.projectRootHash, ignoreCase = true)) {
                "project-scoped Skill requires matching projectRootHash"
            }
        }
        require(s.yaml.isNotBlank()) { "userSkills[*].yaml is required" }
        if (!sha256Matches(s.yaml, s.sha256)) {
            throw IllegalArgumentException("Skill sha256 does not match")
        }
        val tokens = estimateTokens(s.yaml)
        require(tokens <= perSkillTokenBudget) {
            "Skill body too large ($tokens > $perSkillTokenBudget)"
        }
        return ActivatedSkill(
            id = s.id,
            version = s.version,
            source = "user",
            scope = s.scope,
            priority = 50,
            tokens = tokens,
            permissionsTools = allowedTools.toList(),
            systemPrompt = s.yaml,
        )
    }

    private fun estimateTokens(text: String): Int = (text.length + 3) / 4

    private fun sha256Matches(body: String, expectedHex: String?): Boolean {
        if (expectedHex.isNullOrBlank()) return true // optional
        val md = MessageDigest.getInstance("SHA-256")
        val hash = md.digest(body.toByteArray(StandardCharsets.UTF_8))
        val actual = hash.joinToString("") { "%02x".format(it) }
        return actual.equals(expectedHex.removePrefix("sha256:"), ignoreCase = true)
    }

    companion object {
        private val ALLOWED_SCOPES = setOf("project", "global")
    }
}
