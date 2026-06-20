package io.codepilot.core.skill;

import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Decides which Skills activate for a given turn. Combines: - user Skills provided in {@code
 * request.userSkills[]} (validated by {@link UserSkillValidator}) - system Skills loaded by {@link
 * SystemSkillLoader} and matched by {@link TriggerMatcher} Applies explicit allow/deny lists from
 * {@code request.skills.requested/disabled}, per-category caps (lang.primary ≤ 1, lang.aux ≤ 2,
 * scenario ≤ 2, action ≤ 2), and priority ordering.
 */
@Service
public class SkillRouter {

  private static final Logger log = LoggerFactory.getLogger(SkillRouter.class);

  private static final Map<SkillManifest.Category, Integer> CAP =
      Map.of(
          SkillManifest.Category.LANG_PRIMARY, 1,
          SkillManifest.Category.LANG_AUX, 2,
          SkillManifest.Category.SCENARIO, 2,
          SkillManifest.Category.ACTION, 2,
          SkillManifest.Category.GENERIC, 10);

  private final SystemSkillLoader loader;
  private final TriggerMatcher matcher;
  private final WorkspaceProbe probe;
  private final UserSkillValidator userValidator;

  public SkillRouter(
      SystemSkillLoader loader,
      TriggerMatcher matcher,
      WorkspaceProbe probe,
      UserSkillValidator userValidator) {
    this.loader = loader;
    this.matcher = matcher;
    this.probe = probe;
    this.userValidator = userValidator;
  }

  public Result route(ConversationRunRequest req) {
    WorkspaceProbe.Probe p = probe.probe(req);
    Set<String> requested = toSet(req.skills() == null ? null : req.skills().requested());
    Set<String> disabled = toSet(req.skills() == null ? null : req.skills().disabled());

    // 1) system Skills (AGENT only for this iteration; chat skips them)
    List<ActivatedSkill> sys =
        req.mode() == ConversationMode.AGENT ? filterSystem(p, requested, disabled) : List.of();

    // 2) user Skills
    List<ActivatedSkill> users =
        userValidator.validate(
            req.userSkills(),
            req.projectRootHash(),
            req.tools() == null ? Set.of() : Set.copyOf(req.tools()));

    // 3) merge + sort (source first, then priority)
    List<ActivatedSkill> merged = new ArrayList<>(sys.size() + users.size());
    merged.addAll(sys);
    merged.addAll(users);
    merged.sort(
        Comparator.comparing(ActivatedSkill::source)
            .thenComparing(Comparator.comparingInt(ActivatedSkill::priority).reversed()));

    return new Result(p, merged);
  }

  private List<ActivatedSkill> filterSystem(
      WorkspaceProbe.Probe p, Set<String> requested, Set<String> disabled) {
    Map<SkillManifest.Category, List<ActivatedSkill>> buckets = new LinkedHashMap<>();
    for (SkillManifest m : loader.all()) {
      if (!"system".equalsIgnoreCase(m.source())) continue;
      if (disabled.contains(m.id())) continue;
      if (!requested.isEmpty() && !requested.contains(m.id())) {
        // explicit allow-list: only use listed ids
      }
      if (!matcher.matches(m, p)) continue;
      int prio = m.priority() == 0 ? 50 : m.priority();
      buckets
          .computeIfAbsent(m.category(), k -> new ArrayList<>())
          .add(
              new ActivatedSkill(
                  m.id(),
                  m.version(),
                  m.source(),
                  m.scope(),
                  prio,
                  m.audit() != null && m.audit().tokensEstimate() != null
                      ? m.audit().tokensEstimate()
                      : 0,
                  m.permissions() != null ? m.permissions().tools() : List.of(),
                  m.systemPrompt()));
    }
    List<ActivatedSkill> out = new ArrayList<>();
    for (var entry : buckets.entrySet()) {
      int cap = CAP.getOrDefault(entry.getKey(), 10);
      List<ActivatedSkill> bucket = entry.getValue();
      bucket.sort(Comparator.comparingInt(ActivatedSkill::priority).reversed());
      if (bucket.size() > cap) bucket = bucket.subList(0, cap);
      out.addAll(bucket);
    }
    return out;
  }

  private Set<String> toSet(List<String> ids) {
    return ids == null ? Set.of() : Set.copyOf(ids);
  }

  /** Routed output carrying the probe (for audit / observability) plus the activation list. */
  public record Result(WorkspaceProbe.Probe probe, List<ActivatedSkill> skills) {}
}
