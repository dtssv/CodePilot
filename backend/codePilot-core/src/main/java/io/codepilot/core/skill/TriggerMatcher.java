package io.codepilot.core.skill;

import io.codepilot.core.skill.SkillManifest.TriggerGroup;
import io.codepilot.core.skill.SkillManifest.Triggers;
import java.nio.file.FileSystems;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Decides whether a Skill's triggers fire for a given workspace probe.
 *
 * <p>Semantics:
 *
 * <ul>
 *   <li>{@code triggers.all[*]} — every group MUST match (AND of groups).
 *   <li>{@code triggers.any[*]} — any single group is enough (OR of groups).
 *   <li>Within a group, every populated dimension (language, framework, action, fileGlob, keywords)
 *       MUST overlap with the probe — empty dimensions are ignored.
 * </ul>
 */
@Component
public class TriggerMatcher {

  private final ConcurrentHashMap<String, PathMatcher> globCache = new ConcurrentHashMap<>();

  public boolean matches(SkillManifest skill, WorkspaceProbe.Probe probe) {
    Triggers t = skill.triggers();
    if (t == null) return false;

    if (t.all() != null) {
      for (TriggerGroup g : t.all()) {
        if (!matchesGroup(g, probe)) return false;
      }
    }
    if (t.any() != null && !t.any().isEmpty()) {
      boolean any = false;
      for (TriggerGroup g : t.any()) {
        if (matchesGroup(g, probe)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    if ((t.all() == null || t.all().isEmpty()) && (t.any() == null || t.any().isEmpty())) {
      // No triggers configured -> the Skill is always-on (e.g. patching guidance).
      return true;
    }
    return true;
  }

  // ---------------- helpers ----------------

  private boolean matchesGroup(TriggerGroup g, WorkspaceProbe.Probe probe) {
    if (g == null) return true;
    if (!intersectIfPresent(g.language(), probe.languages())) return false;
    if (!intersectIfPresent(g.framework(), probe.frameworks())) return false;
    if (!intersectIfPresent(g.action(), action(probe))) return false;
    if (!intersectIfPresent(g.keywords(), probe.keywords())) return false;
    if (!matchesAnyGlob(g.fileGlob(), probe.filePaths())) return false;
    return true;
  }

  private boolean intersectIfPresent(List<String> required, Set<String> available) {
    if (required == null || required.isEmpty()) return true;
    for (String r : required) {
      if (r == null || r.isBlank()) continue;
      if (available.contains(r.toLowerCase())) return true;
    }
    return false;
  }

  private Set<String> action(WorkspaceProbe.Probe probe) {
    return probe.action() == null ? Set.of() : Set.of(probe.action());
  }

  private static final String GLOB_PREFIX = "glob:";
  private static final String REGEX_PREFIX = "regex:";

  private boolean matchesAnyGlob(List<String> globs, Set<String> paths) {
    if (globs == null || globs.isEmpty()) return true;
    if (paths == null || paths.isEmpty()) return false;
    for (String glob : globs) {
      if (glob == null || glob.isBlank()) continue;
      String syntaxAndPattern = ensurePrefix(glob);
      try {
        PathMatcher matcher =
            globCache.computeIfAbsent(syntaxAndPattern, FileSystems.getDefault()::getPathMatcher);
        for (String p : paths) {
          try {
            Path path = Path.of(p);
            if (matcher.matches(path) || matcher.matches(path.getFileName())) return true;
          } catch (RuntimeException ignored) {
            // malformed path; skip
          }
        }
      } catch (IllegalArgumentException | UnsupportedOperationException ignored) {
        // invalid glob syntax; skip this pattern
      }
    }
    return false;
  }

  /** Ensure the pattern has a {@code glob:} or {@code regex:} prefix; default to {@code glob:}. */
  private static String ensurePrefix(String pattern) {
    if (pattern.startsWith(GLOB_PREFIX) || pattern.startsWith(REGEX_PREFIX)) return pattern;
    return GLOB_PREFIX + pattern;
  }
}
