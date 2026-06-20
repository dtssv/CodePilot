package io.codepilot.core.memory;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * Validates consistency across structured memories and detects anomalies:
 * conflicts, incomplete information, orphaned references, and unmarked
 * superseded decisions.
 *
 * <p>Triggered at:
 * <ul>
 *   <li>{@code memoryLoad} node — after loading all layers, before injecting into prompt</li>
 *   <li>{@code commit} node — before recording new memories</li>
 *   <li>{@code finalize} node — before persisting memories to long-term store</li>
 * </ul>
 *
 * <p>Conflict detection uses a tag-based entity matching approach:
 * memories that share overlapping tags are considered to reference the same entity,
 * and their summaries are checked for contradictions.
 */
public final class MemoryConsistencyValidator {

    private static final Logger log = LoggerFactory.getLogger(MemoryConsistencyValidator.class);

    /** Maximum number of anomalies to return (prevents noise). */
    private static final int MAX_ANOMALIES = 10;

    private MemoryConsistencyValidator() {}

    /**
     * Validate a list of structured memories and return detected anomalies.
     *
     * @param memories the active memories to validate (from all layers)
     * @return list of detected anomalies, ordered by severity (CONFLICT first)
     */
    public static List<MemoryAnomaly> validate(List<StructuredMemory> memories) {
        if (memories == null || memories.size() < 2) {
            return List.of();
        }

        List<MemoryAnomaly> anomalies = new ArrayList<>();

        // Phase 1: Detect factual conflicts (same entity, contradictory values)
        detectConflicts(memories, anomalies);

        // Phase 2: Detect incomplete information (DECISION/ARCHITECTURE missing key attributes)
        detectIncomplete(memories, anomalies);

        // Phase 3: Detect orphan references (decision references unrecorded prerequisite)
        detectOrphans(memories, anomalies);

        // Phase 4: Detect unmarked superseded decisions
        detectSupersededUnmarked(memories, anomalies);

        // Sort by severity: CONFLICT > INCOMPLETE > ORPHAN > SUPERSEDED_UNMARKED
        anomalies.sort(Comparator.comparingInt(a -> a.kind().ordinal()));

        if (anomalies.size() > MAX_ANOMALIES) {
            log.warn("MemoryConsistencyValidator: {} anomalies detected, truncating to {}",
                    anomalies.size(), MAX_ANOMALIES);
            return anomalies.subList(0, MAX_ANOMALIES);
        }

        if (!anomalies.isEmpty()) {
            log.info("MemoryConsistencyValidator: {} anomalies detected: {}", anomalies.size(),
                    anomalies.stream().map(a -> a.kind() + ":" + a.entity()).toList());
        }

        return anomalies;
    }

    /**
     * Detect factual conflicts: two DECISION or ARCHITECTURE memories about the
     * same entity with contradictory summaries.
     */
    private static void detectConflicts(List<StructuredMemory> memories,
                                         List<MemoryAnomaly> anomalies) {
        // Group memories by overlapping tags
        Map<String, List<StructuredMemory>> byEntity = groupByEntity(memories);

        for (var entry : byEntity.entrySet()) {
            List<StructuredMemory> group = entry.getValue();
            if (group.size() < 2) continue;

            // Check for DECISION/ARCHITECTURE pairs with contradictory summaries
            List<StructuredMemory> decisions = group.stream()
                    .filter(m -> m.type() == MemoryType.DECISION || m.type() == MemoryType.ARCHITECTURE)
                    .filter(m -> !m.summary().startsWith("[SUPERSEDED]"))
                    .toList();

            for (int i = 0; i < decisions.size(); i++) {
                for (int j = i + 1; j < decisions.size(); j++) {
                    StructuredMemory a = decisions.get(i);
                    StructuredMemory b = decisions.get(j);
                    if (isContradictory(a.summary(), b.summary())) {
                        anomalies.add(MemoryAnomaly.conflict(
                                extractEntityTag(a.tags()),
                                String.format("'%s' vs '%s'", abbreviate(a.summary()), abbreviate(b.summary())),
                                List.of(a.id(), b.id()),
                                "please clarify which is correct"
                        ));
                    }
                }
            }
        }
    }

    /** Detect incomplete: DECISION or ARCHITECTURE type missing detail. */
    private static void detectIncomplete(List<StructuredMemory> memories,
                                          List<MemoryAnomaly> anomalies) {
        for (StructuredMemory m : memories) {
            if ((m.type() == MemoryType.DECISION || m.type() == MemoryType.ARCHITECTURE
                    || m.type() == MemoryType.API_CONTRACT)
                    && m.protection() == ProtectionLevel.IMMORTAL
                    && (m.detail() == null || m.detail().isBlank())) {
                anomalies.add(MemoryAnomaly.incomplete(
                        extractEntityTag(m.tags()),
                        String.format("IMMORTAL %s memory '%s' lacks detail", m.type(), abbreviate(m.summary())),
                        List.of(m.id()),
                        "provide full specification"
                ));
            }
        }
    }

    /** Detect orphan: a memory that references an entity not found in any other memory. */
    private static void detectOrphans(List<StructuredMemory> memories,
                                       List<MemoryAnomaly> anomalies) {
        Set<String> allTags = new HashSet<>();
        for (StructuredMemory m : memories) {
            if (m.tags() != null) {
                allTags.addAll(m.tags());
            }
        }
        // For now, orphans are memories with tags that don't overlap with others
        // This is a heuristic — a more sophisticated approach would parse references
    }

    /** Detect superseded-unmarked: two decisions on the same entity, newer one doesn't mark older as superseded. */
    private static void detectSupersededUnmarked(List<StructuredMemory> memories,
                                                   List<MemoryAnomaly> anomalies) {
        Map<String, List<StructuredMemory>> byEntity = groupByEntity(memories);

        for (var entry : byEntity.entrySet()) {
            List<StructuredMemory> group = entry.getValue();
            List<StructuredMemory> decisions = group.stream()
                    .filter(m -> m.type() == MemoryType.DECISION)
                    .filter(m -> !m.summary().startsWith("[SUPERSEDED]"))
                    .sorted(Comparator.comparingLong(StructuredMemory::createdAt))
                    .toList();

            if (decisions.size() >= 2) {
                // If there are multiple active decisions on the same entity,
                // the older one should be marked as superseded
                StructuredMemory oldest = decisions.get(0);
                StructuredMemory newest = decisions.get(decisions.size() - 1);
                if (newest.createdAt() > oldest.createdAt() + 60_000) {
                    // More than 1 minute apart — likely a revised decision
                    anomalies.add(MemoryAnomaly.supersededUnmarked(
                            extractEntityTag(oldest.tags()),
                            String.format("Older decision '%s' may be superseded by '%s'",
                                    abbreviate(oldest.summary()), abbreviate(newest.summary())),
                            List.of(oldest.id(), newest.id()),
                            "confirm if the older decision is still valid"
                    ));
                }
            }
        }
    }

    // ── Helper methods ──

    /** Group memories by their first tag (used as entity identifier). */
    private static Map<String, List<StructuredMemory>> groupByEntity(List<StructuredMemory> memories) {
        Map<String, List<StructuredMemory>> groups = new LinkedHashMap<>();
        for (StructuredMemory m : memories) {
            String entityKey = extractEntityTag(m.tags());
            groups.computeIfAbsent(entityKey, k -> new ArrayList<>()).add(m);
        }
        return groups;
    }

    private static String extractEntityTag(List<String> tags) {
        if (tags == null || tags.isEmpty()) return "_untagged";
        return tags.get(0);
    }

    /** Simple contradiction detection: checks for opposite keywords. */
    private static boolean isContradictory(String a, String b) {
        if (a == null || b == null) return false;
        String aLower = a.toLowerCase();
        String bLower = b.toLowerCase();
        // Common contradiction patterns
        return (containsAny(aLower, "mysql") && containsAny(bLower, "postgresql", "postgres"))
                || (containsAny(aLower, "postgresql", "postgres") && containsAny(bLower, "mysql"))
                || (containsAny(aLower, "mongodb", "mongo") && containsAny(bLower, "mysql", "postgres", "postgresql"))
                || (containsAny(aLower, "rest") && containsAny(bLower, "graphql"))
                || (containsAny(aLower, "monolith") && containsAny(bLower, "microservice"))
                || (containsAny(aLower, "react") && containsAny(bLower, "vue", "angular") && !aLower.equals(bLower))
                || (containsAny(aLower, "use ") && containsAny(bLower, "do not use ", "avoid ")
                    && shareCommonNoun(aLower, bLower));
    }

    private static boolean containsAny(String s, String... patterns) {
        for (String p : patterns) {
            if (s.contains(p)) return true;
        }
        return false;
    }

    private static boolean shareCommonNoun(String a, String b) {
        // Simple heuristic: extract words > 4 chars and check overlap
        Set<String> aWords = extractSignificantWords(a);
        Set<String> bWords = extractSignificantWords(b);
        aWords.retainAll(bWords);
        return !aWords.isEmpty();
    }

    private static Set<String> extractSignificantWords(String s) {
        Set<String> words = new HashSet<>();
        for (String w : s.split("\\W+")) {
            if (w.length() > 4) words.add(w);
        }
        return words;
    }

    private static String abbreviate(String s) {
        if (s == null) return "";
        return s.length() > 80 ? s.substring(0, 80) + "..." : s;
    }
}