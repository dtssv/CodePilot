package io.codepilot.core.graph;

import io.codepilot.core.memory.MemoryLayer;
import io.codepilot.core.memory.MemoryType;
import io.codepilot.core.memory.ProtectionLevel;
import io.codepilot.core.memory.StructuredMemory;
import io.codepilot.core.tool.ToolMemoryProfile;

import java.util.*;

/**
 * Unified classifier for memory content — <b>metadata-first, content-based fallback</b>.
 *
 * <h3>Strategy priority (highest to lowest)</h3>
 * <ol>
 *   <li><b>Result-level metadata</b> — tools embed {@code memoryHint} or {@code resultType}
 *       in their result map.  This is the most reliable signal because the tool itself
 *       declares what it produced.  Works for any past, present, or future tool
 *       without code changes.</li>
 *   <li><b>Tool-schema profile</b> — each tool registered in the tool registry
 *       carries a {@link ToolMemoryProfile} that declares whether its results are
 *       memory-worthy and what type/protection/tags to assign.  Classification is
 *       driven by the tool's own declaration, not by guessing from content keywords.</li>
 *   <li><b>Content-based fallback</b> — for data that has no tool provenance (e.g.
 *       conversation history, session digests), a minimal structural heuristic is used:
 *       content length + role signals.  No technology-specific keywords are used.</li>
 * </ol>
 *
 * <p>This design ensures that adding a new tool or technology stack never requires
 * modifying this classifier — the tool either carries metadata in its result, or
 * declares a {@link ToolMemoryProfile} at registration time.
 */
public final class MemoryContentClassifier {

    private MemoryContentClassifier() {}

    /** Functional interface for resolving tool memory profiles — avoids hard dependency on ToolSchemaRegistry. */
    @FunctionalInterface
    public interface ToolProfileResolver {
        ToolMemoryProfile resolve(String toolName);
    }

    private static volatile ToolProfileResolver profileResolver =
            name -> ToolMemoryProfile.NOT_WORTHY;

    /**
     * Initialize the classifier with a tool profile resolver.
     * Typically wired to {@code registry::getMemoryProfile} at startup.
     */
    public static void init(ToolProfileResolver resolver) {
        profileResolver = resolver;
    }

    private static ToolProfileResolver profileResolver() {
        return profileResolver;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ── Public API: gathered-info classification ─────────────────────────
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Classify a single gathered-info entry.
     *
     * <p>Strategy: result metadata → tool-schema profile → skip.
     * Content-based keyword matching is NOT used.
     *
     * @param entry   the gathered-info value map (must contain "kind", "result", etc.)
     * @param phaseId the current phase identifier
     * @return a StructuredMemory candidate, or empty if the entry is not memory-worthy
     */
    public static Optional<StructuredMemory> classifyEntry(
            Map<String, Object> entry, String phaseId) {

        String kind = String.valueOf(entry.getOrDefault("kind", ""));
        if (kind.isBlank()) return Optional.empty();

        // ── Priority 1: result-level metadata (tool-driven) ──
        String hint = metadataHint(entry);
        if (hint != null) {
            return fromHint(hint, entry, phaseId);
        }
        String rt = resultType(entry);
        if (rt != null) {
            return fromResultType(rt, entry, phaseId);
        }

        // ── Priority 2: tool-schema profile ──
        ToolMemoryProfile profile = profileResolver.resolve(kind);
        if (profile.memoryWorthy()) {
            return fromProfile(profile, entry, kind, phaseId);
        }

        // Not memory-worthy — skip
        return Optional.empty();
    }

    /**
     * Batch-classify all entries in a gathered-info map.
     *
     * @param gathered      the full gatheredInfo map
     * @param phaseId       the current phase identifier
     * @param maxCandidates upper bound on returned candidates
     * @return list of structured memory candidates (never null)
     */
    public static List<StructuredMemory> classifyAll(
            Map<String, Object> gathered, String phaseId, int maxCandidates) {
        List<StructuredMemory> candidates = new ArrayList<>();
        for (var entry : gathered.entrySet()) {
            Object value = entry.getValue();
            if (!(value instanceof Map<?, ?> rawMap)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) rawMap;
            if (!GatheredInfoFormatter.entrySucceeded(map)) continue;

            classifyEntry(map, phaseId).ifPresent(candidates::add);
            if (candidates.size() >= maxCandidates) break;
        }
        return candidates;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ── Public API: content-based classification (fallback only) ─────────
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Classify protection level for content that has no tool provenance
     * (e.g. conversation history, session digests).
     *
     * <p>Uses <b>structural signals</b> instead of keyword matching:
     * <ul>
     *   <li>Long, structured content → higher protection</li>
     *   <li>Short, chatty content → lower protection</li>
     * </ul>
     */
    public static ProtectionLevel classifyProtectionLevel(String content) {
        if (content == null || content.isBlank()) return ProtectionLevel.VOLATILE;
        // Structural heuristic: content with multiple lines and substantial length
        // is more likely to contain meaningful information worth protecting.
        // This is technology-agnostic — no keyword matching.
        int lineCount = countLines(content);
        int length = content.length();

        if (lineCount >= 10 && length >= 500) return ProtectionLevel.IMMORTAL;
        if (lineCount >= 5  && length >= 200) return ProtectionLevel.PROTECTED;
        if (length >= 100) return ProtectionLevel.DEGRADABLE;
        return ProtectionLevel.VOLATILE;
    }

    /**
     * Classify memory type for content that has no tool provenance.
     *
     * <p>Uses <b>structural signals</b> instead of keyword matching:
     * <ul>
     *   <li>Long multi-line blocks with code-like structure → ARCHITECTURE</li>
     *   <li>Medium content with clear intent → DECISION</li>
     *   <li>Everything else → FACT</li>
     * </ul>
     */
    public static MemoryType classifyMemoryType(String content) {
        if (content == null || content.isBlank()) return MemoryType.FACT;
        // Structural heuristic: multi-line structured content tends to be
        // architecture/decision-level, while short messages are facts.
        int lineCount = countLines(content);
        int length = content.length();

        if (lineCount >= 8 && length >= 300) return MemoryType.ARCHITECTURE;
        if (lineCount >= 3 && length >= 100) return MemoryType.DECISION;
        return MemoryType.FACT;
    }

    /**
     * Extract semantic tags from content using structural signals.
     *
     * <p>Derives tags from <b>observable structure</b> rather than keywords:
     * <ul>
     *   <li>Content with file paths → "source"</li>
     *   <li>Content with code blocks → "code"</li>
     *   <li>Content with URLs/endpoints → "network"</li>
     *   <li>Long content → "detailed"</li>
     * </ul>
     */
    public static List<String> extractTags(String content) {
        if (content == null || content.isBlank()) return List.of();
        Set<String> tags = new LinkedHashSet<>();

        // Structural tag extraction — technology-agnostic
        if (content.contains("/") && (content.contains(".java") || content.contains(".py")
                || content.contains(".ts") || content.contains(".js") || content.contains(".go")
                || content.contains(".rs") || content.contains(".kt") || content.contains(".swift")
                || content.contains(".c") || content.contains(".cpp") || content.contains(".rb"))) {
            tags.add("source");
        }
        if (content.contains("```") || content.contains("import ") || content.contains("package ")) {
            tags.add("code");
        }
        if (content.contains("://") || content.contains("localhost") || content.contains("endpoint")) {
            tags.add("network");
        }
        if (content.contains("{") && content.contains("}") || content.contains("[") && content.contains("]")) {
            tags.add("structured");
        }
        if (content.length() > 500) {
            tags.add("detailed");
        }

        return new ArrayList<>(tags);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ── Internal: metadata-driven classification ─────────────────────────
    // ═══════════════════════════════════════════════════════════════════════

    private static String metadataHint(Map<String, Object> entry) {
        Object result = entry.get("result");
        if (result instanceof Map<?, ?> resultMap) {
            Object hint = resultMap.get("memoryHint");
            if (hint != null && !hint.toString().isBlank()) return hint.toString().trim().toLowerCase();
        }
        Object hint = entry.get("memoryHint");
        if (hint != null && !hint.toString().isBlank()) return hint.toString().trim().toLowerCase();
        return null;
    }

    private static String resultType(Map<String, Object> entry) {
        Object result = entry.get("result");
        if (result instanceof Map<?, ?> resultMap) {
            Object rt = resultMap.get("resultType");
            if (rt != null && !rt.toString().isBlank()) return rt.toString().trim().toLowerCase();
        }
        return null;
    }

    private static Optional<StructuredMemory> fromHint(
            String hint, Map<String, Object> entry, String phaseId) {
        String resultStr = resultString(entry);
        if (resultStr.isBlank()) return Optional.empty();

        MemoryType type = switch (hint) {
            case "architecture" -> MemoryType.ARCHITECTURE;
            case "decision" -> MemoryType.DECISION;
            case "api_contract" -> MemoryType.API_CONTRACT;
            default -> MemoryType.FACT;
        };
        ProtectionLevel protection = switch (hint) {
            case "architecture", "api_contract" -> ProtectionLevel.IMMORTAL;
            case "decision" -> ProtectionLevel.PROTECTED;
            default -> ProtectionLevel.PROTECTED;
        };

        return Optional.of(StructuredMemory.of(
                MemoryLayer.SHORT_TERM, protection, type,
                truncate(resultStr, 200), truncate(resultStr, 1000),
                List.of(hint, phaseId), phaseId));
    }

    private static Optional<StructuredMemory> fromResultType(
            String resultType, Map<String, Object> entry, String phaseId) {
        Set<String> architectureTypes = Set.of(
                "schema", "api", "config", "architecture", "design", "model", "routing");
        if (!architectureTypes.contains(resultType)) return Optional.empty();
        String resultStr = resultString(entry);
        if (resultStr.isBlank()) return Optional.empty();

        return Optional.of(StructuredMemory.of(
                MemoryLayer.SHORT_TERM, ProtectionLevel.PROTECTED, MemoryType.ARCHITECTURE,
                truncate(resultStr, 200), truncate(resultStr, 1000),
                List.of(resultType, phaseId), phaseId));
    }

    private static Optional<StructuredMemory> fromProfile(
            ToolMemoryProfile profile, Map<String, Object> entry,
            String kind, String phaseId) {
        String resultStr = resultString(entry);
        if (resultStr.isBlank()) return Optional.empty();

        List<String> tags = new ArrayList<>(profile.defaultTags());
        tags.add(kind);
        tags.add(phaseId);

        return Optional.of(StructuredMemory.of(
                MemoryLayer.SHORT_TERM,
                profile.defaultProtection(),
                profile.defaultType(),
                truncate(resultStr, 200),
                truncate(resultStr, 1000),
                tags,
                phaseId));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ── Helpers ──────────────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════

    @SuppressWarnings("unchecked")
    private static String resultString(Map<String, Object> entry) {
        Object result = entry.get("result");
        if (result == null) return "";
        if (result instanceof CharSequence cs) return cs.toString();
        if (result instanceof Map<?, ?> map) {
            Object stdout = map.get("stdout");
            if (stdout != null) return stdout.toString();
            return map.toString();
        }
        return result.toString();
    }

    private static String truncate(String s, int maxLen) {
        if (s.length() <= maxLen) return s;
        return s.substring(0, maxLen) + "...";
    }

    private static int countLines(String s) {
        if (s == null || s.isEmpty()) return 0;
        int count = 1;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '\n') count++;
        }
        return count;
    }

}