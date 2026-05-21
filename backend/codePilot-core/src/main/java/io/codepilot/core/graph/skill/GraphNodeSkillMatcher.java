package io.codepilot.core.graph.skill;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.skill.ActivatedSkill;
import io.codepilot.core.skill.SkillManifest;
import io.codepilot.core.skill.SkillRouter;
import io.codepilot.core.skill.SystemSkillLoader;
import io.codepilot.core.skill.TriggerMatcher;
import io.codepilot.core.skill.WorkspaceProbe;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Matches Skills for a specific graph node. User Skill bodies are looked up from
 * {@code userSkillBodies} in state (plugin provides bodies only for workspace-matched skills).
 *
 * <p><b>Per-request / per-node behavior:</b> Trigger evaluation runs again for every
 * graph step; a skill is activated only if {@link TriggerMatcher#matches} succeeds for
 * that node’s {@link WorkspaceProbe} <em>and</em> a non-blank body exists in
 * {@code userSkillBodies}. Missing body → no injection (full skill text is never
 * fabricated server-side).
 */
@Component
public class GraphNodeSkillMatcher {

    private static final Logger log = LoggerFactory.getLogger(GraphNodeSkillMatcher.class);

    private static final Map<SkillManifest.Category, Integer> CAP =
            Map.of(
                    SkillManifest.Category.LANG_PRIMARY, 1,
                    SkillManifest.Category.LANG_AUX, 2,
                    SkillManifest.Category.SCENARIO, 2,
                    SkillManifest.Category.ACTION, 2,
                    SkillManifest.Category.GENERIC, 10);

    private final SystemSkillLoader loader;
    private final TriggerMatcher matcher;

    public GraphNodeSkillMatcher(SystemSkillLoader loader, TriggerMatcher matcher) {
        this.loader = loader;
        this.matcher = matcher;
    }

    @SuppressWarnings("unchecked")
    public List<ActivatedSkill> match(OverAllState state, GraphSkillNode node) {
        WorkspaceProbe.Probe probe = GraphWorkspaceProbe.fromState(state, node);
        Set<String> disabled = toSet(readSkillsConfig(state, "disabled"));
        Set<String> requested = toSet(readSkillsConfig(state, "requested"));

        Map<SkillManifest.Category, List<ActivatedSkill>> buckets = new LinkedHashMap<>();

        for (SkillManifest m : loader.all()) {
            if (!"system".equalsIgnoreCase(m.source())) continue;
            if (disabled.contains(m.id())) continue;
            if (!requested.isEmpty() && !requested.contains(m.id())) continue;
            if (!nodeAllowsSystemSkill(node, m)) continue;
            if (!matcher.matches(m, probe)) continue;
            addToBucket(buckets, m.category(), toActivated(m));
        }

        List<ConversationRunRequest.UserSkillRef> refs =
                (List<ConversationRunRequest.UserSkillRef>) state.value("userSkillRefs").orElse(List.of());
        Map<String, String> bodies =
                (Map<String, String>) state.value("userSkillBodies").orElse(Map.of());

        for (ConversationRunRequest.UserSkillRef ref : refs) {
            if (ref == null || disabled.contains(ref.id())) continue;
            if (!requested.isEmpty() && !requested.contains(ref.id())) continue;
            SkillManifest manifest = ref.toManifest();
            if (!matcher.matches(manifest, probe)) continue;
            String key = ref.id() + "@" + ref.version();
            String body = bodies.get(key);
            if (body == null || body.isBlank()) {
                log.debug("GraphNodeSkillMatcher: no body for user skill {} at node {}", key, node);
                continue;
            }
            SkillManifest.Category cat =
                    ref.category() != null ? ref.category() : SkillManifest.Category.GENERIC;
            int prio = ref.priority() > 0 ? ref.priority() : 50;
            buckets.computeIfAbsent(cat, k -> new ArrayList<>())
                    .add(
                            new ActivatedSkill(
                                    ref.id(),
                                    ref.version(),
                                    "user",
                                    ref.scope(),
                                    prio,
                                    body.length() / 4,
                                    List.of(),
                                    body));
        }

        return applyCaps(buckets);
    }

    private boolean nodeAllowsSystemSkill(GraphSkillNode node, SkillManifest m) {
        return switch (node) {
            case INTAKE -> m.category() == SkillManifest.Category.LANG_PRIMARY
                    || m.category() == SkillManifest.Category.LANG_AUX;
            case PLANNING -> m.category() != SkillManifest.Category.ACTION
                    || isActionSkillForNode(m, "plan", "review");
            case GENERATE -> true;
            case REPAIR -> m.category() == SkillManifest.Category.ACTION
                    || m.category() == SkillManifest.Category.LANG_PRIMARY
                    || m.category() == SkillManifest.Category.GENERIC;
        };
    }

    private boolean isActionSkillForNode(SkillManifest m, String... hints) {
        String id = m.id() == null ? "" : m.id().toLowerCase();
        for (String h : hints) {
            if (id.contains(h)) return true;
        }
        return false;
    }

    private ActivatedSkill toActivated(SkillManifest m) {
        int prio = m.priority() == 0 ? 50 : m.priority();
        int tokens =
                m.audit() != null && m.audit().tokensEstimate() != null
                        ? m.audit().tokensEstimate()
                        : 0;
        return new ActivatedSkill(
                m.id(),
                m.version(),
                m.source(),
                m.scope(),
                prio,
                tokens,
                m.permissions() != null ? m.permissions().tools() : List.of(),
                m.systemPrompt());
    }

    private void addToBucket(
            Map<SkillManifest.Category, List<ActivatedSkill>> buckets,
            SkillManifest.Category category,
            ActivatedSkill skill) {
        buckets.computeIfAbsent(category == null ? SkillManifest.Category.GENERIC : category, k -> new ArrayList<>())
                .add(skill);
    }

    private List<ActivatedSkill> applyCaps(Map<SkillManifest.Category, List<ActivatedSkill>> buckets) {
        List<ActivatedSkill> out = new ArrayList<>();
        for (var entry : buckets.entrySet()) {
            int cap = CAP.getOrDefault(entry.getKey(), 10);
            List<ActivatedSkill> bucket = new ArrayList<>(entry.getValue());
            bucket.sort(Comparator.comparingInt(ActivatedSkill::priority).reversed());
            if (bucket.size() > cap) {
                bucket = bucket.subList(0, cap);
            }
            out.addAll(bucket);
        }
        out.sort(
                Comparator.comparing(ActivatedSkill::source)
                        .thenComparing(Comparator.comparingInt(ActivatedSkill::priority).reversed()));
        return out;
    }

    @SuppressWarnings("unchecked")
    private List<String> readSkillsConfig(OverAllState state, String field) {
        Object raw = state.value("skillsConfig").orElse(null);
        if (!(raw instanceof Map<?, ?> map)) return List.of();
        Object val = map.get(field);
        if (val instanceof List<?> list) {
            return list.stream().map(String::valueOf).toList();
        }
        return List.of();
    }

    private Set<String> toSet(List<String> ids) {
        return ids == null || ids.isEmpty() ? Set.of() : Set.copyOf(ids);
    }
}
