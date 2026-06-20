package io.codepilot.core.skill;

import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.context.TokenMeter;
import io.codepilot.core.dto.ConversationRunRequest;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * Verifies safety constraints on user-supplied Skills before they are merged into the system. The
 * goal is to make sure plugins / third-party marketplaces cannot smuggle a "system" Skill into the
 * orchestrator: only {@code source=user} is accepted, and {@code scope} must be {@code project} or
 * {@code global}; {@code project} additionally requires a matching {@code projectRootHash}.
 */
@Service
public class UserSkillValidator {

  private static final Set<String> ALLOWED_SCOPES = Set.of("project", "global");
  private static final int PER_SKILL_TOKEN_BUDGET = 600;

  private final TokenMeter meter;

  public UserSkillValidator(TokenMeter meter) {
    this.meter = meter;
  }

  /**
   * Returns the validated {@link ActivatedSkill} list (one per user Skill). Throws {@link
   * CodePilotException} with {@link ErrorCodes#USER_SKILL_INVALID} when the input is malformed.
   */
  public List<ActivatedSkill> validate(
      List<ConversationRunRequest.UserSkill> userSkills,
      String requestProjectRootHash,
      Set<String> allowedTools) {
    if (userSkills == null || userSkills.isEmpty()) return List.of();

    return userSkills.stream()
        .map(s -> toActivated(s, requestProjectRootHash, allowedTools))
        .toList();
  }

  private ActivatedSkill toActivated(
      ConversationRunRequest.UserSkill s, String reqRootHash, Set<String> allowedTools) {
    if (!"user".equalsIgnoreCase(s.source())) {
      throw new CodePilotException(
          ErrorCodes.USER_SKILL_INVALID, "userSkills[*].source must be 'user'");
    }
    if (s.scope() == null || !ALLOWED_SCOPES.contains(s.scope())) {
      throw new CodePilotException(
          ErrorCodes.USER_SKILL_INVALID, "userSkills[*].scope must be 'project' or 'global'");
    }
    if ("project".equals(s.scope())) {
      if (reqRootHash == null || !reqRootHash.equalsIgnoreCase(s.projectRootHash())) {
        throw new CodePilotException(
            ErrorCodes.USER_SKILL_INVALID,
            "project-scoped Skill requires matching projectRootHash");
      }
    }
    if (s.yaml() == null || s.yaml().isBlank()) {
      throw new CodePilotException(ErrorCodes.USER_SKILL_INVALID, "userSkills[*].yaml is required");
    }
    if (!sha256Matches(s.yaml(), s.sha256())) {
      throw new CodePilotException(ErrorCodes.USER_SKILL_INVALID, "Skill sha256 does not match");
    }
    int tokens = meter.count(s.yaml());
    if (tokens > PER_SKILL_TOKEN_BUDGET) {
      throw new CodePilotException(
          ErrorCodes.USER_SKILL_INVALID,
          "Skill body too large (" + tokens + " > " + PER_SKILL_TOKEN_BUDGET + ")");
    }
    return new ActivatedSkill(
        s.id(),
        s.version(),
        "user",
        s.scope(),
        50,
        tokens,
        List.copyOf(allowedTools == null ? Set.of() : allowedTools),
        s.yaml());
  }

  private static boolean sha256Matches(String body, String expectedHex) {
    if (expectedHex == null || expectedHex.isBlank()) return true; // optional in M3
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      byte[] hash = md.digest(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      String actual = HexFormat.of().formatHex(hash);
      return actual.equalsIgnoreCase(expectedHex.replace("sha256:", ""));
    } catch (NoSuchAlgorithmException e) {
      return false;
    }
  }
}
