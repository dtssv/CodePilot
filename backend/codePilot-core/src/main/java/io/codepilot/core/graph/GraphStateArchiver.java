package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.run.GraphEngineProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.data.redis.core.ReactiveRedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.*;

/**
 * Archives completed phase details from active graph state to Redis,
 * keeping only summaries in the live state to prevent unbounded state growth
 * during super-complex tasks (100+ phases).
 *
 * <h3>Mechanism:</h3>
 * <ul>
 *   <li>When completedPhases.size() exceeds the configured threshold (default 50),
 *       older phase details (patches, gathered info, verify reports) are serialized
 *       and stored in Redis under key {@code archive:phase:{sessionId}:{phaseId}}</li>
 *   <li>The active state retains only: phase ID, title, intent, and list of modified file paths</li>
 *   <li>Archived data can be re-loaded on demand if needed for repair/analysis</li>
 * </ul>
 *
 * <p>This prevents graph state from growing to tens of MB during 400+ phase executions,
 * which would cause memory pressure and slow down StateGraph's internal operations.
 */
@Component
public class GraphStateArchiver {

    private static final Logger log = LoggerFactory.getLogger(GraphStateArchiver.class);
    private static final String KEY_PREFIX = "archive:phase:";
    private static final Duration ARCHIVE_TTL = Duration.ofDays(3);

    private final ReactiveRedisTemplate<String, String> template;
    private final ObjectMapper mapper;
    private final GraphEngineProperties graphProperties;

    public GraphStateArchiver(ReactiveRedisConnectionFactory connectionFactory,
                              ObjectMapper mapper,
                              GraphEngineProperties graphProperties) {
        var serializer = new StringRedisSerializer();
        var ctx = RedisSerializationContext.<String, String>newSerializationContext(serializer)
                .key(serializer).value(serializer).hashKey(serializer).hashValue(serializer)
                .build();
        this.template = new ReactiveRedisTemplate<>(connectionFactory, ctx);
        this.mapper = mapper;
        this.graphProperties = graphProperties;
    }

    /**
     * Check if archiving should be triggered based on completed phase count.
     * Returns true when completedPhases exceeds the configured threshold.
     */
    public boolean shouldArchive(OverAllState state) {
        @SuppressWarnings("unchecked")
        List<String> completedPhases =
                (List<String>) state.value("completedPhases").orElse(List.of());
        int threshold = graphProperties.getStateArchiveThreshold();
        return completedPhases.size() > threshold;
    }

    /**
     * Archive older phase details to Redis, keeping only recent phases in active state.
     * Returns the set of phase IDs that were archived.
     */
    @SuppressWarnings("unchecked")
    public Set<String> archiveOldPhases(OverAllState state, Map<String, Object> updates) {
        List<String> completedPhases =
                (List<String>) state.value("completedPhases").orElse(List.of());

        int threshold = graphProperties.getStateArchiveThreshold();
        // Keep the most recent threshold phases, archive older ones
        int archiveCount = completedPhases.size() - threshold;
        if (archiveCount <= 0) return Set.of();

        String sessionId = (String) state.value("sessionId").orElse("");
        Set<String> archivedIds = new HashSet<>();

        // Archive the oldest phases
        List<String> toArchive = completedPhases.subList(0, archiveCount);
        List<String> toKeep = completedPhases.subList(archiveCount, completedPhases.size());

        for (String phaseId : toArchive) {
            // Build phase archive payload from state
            Map<String, Object> phaseArchive = buildPhaseArchive(state, phaseId);
            if (!phaseArchive.isEmpty()) {
                String key = KEY_PREFIX + sessionId + ":" + phaseId;
                try {
                    String json = mapper.writeValueAsString(phaseArchive);
                    // Fire-and-forget archive (non-blocking, non-fatal)
                    template.opsForValue().set(key, json, ARCHIVE_TTL).subscribe();
                    archivedIds.add(phaseId);
                } catch (Exception e) {
                    log.warn("GraphStateArchiver: failed to archive phase {} (non-fatal): {}", phaseId, e.getMessage());
                }
            }
        }

        // Update state: keep only recent phases in completedPhases
        updates.put("completedPhases", List.copyOf(toKeep));
        updates.put("archivedPhaseCount", archivedIds.size());

        log.info("GraphStateArchiver: archived {} old phases, keeping {} recent phases in state",
                archivedIds.size(), toKeep.size());

        return archivedIds;
    }

    /**
     * Load an archived phase's details from Redis (for repair/analysis needs).
     */
    public Mono<Map<String, Object>> loadArchivedPhase(String sessionId, String phaseId) {
        String key = KEY_PREFIX + sessionId + ":" + phaseId;
        return template.opsForValue().get(key)
                .mapNotNull(json -> {
                    try {
                        return mapper.readValue(json, new TypeReference<Map<String, Object>>() {});
                    } catch (Exception e) {
                        log.warn("GraphStateArchiver: failed to deserialize archived phase {}: {}", phaseId, e.getMessage());
                        return null;
                    }
                });
    }

    /** Build archive payload for a specific phase from current state. */
    private Map<String, Object> buildPhaseArchive(OverAllState state, String phaseId) {
        Map<String, Object> archive = new LinkedHashMap<>();
        archive.put("phaseId", phaseId);

        // Store all modified files — while this includes files from multiple phases,
        // the list is append-only and relatively small compared to other state fields.
        // Per-phase file tracking would require a structural change to CommitAction
        // that is not justified at this stage.
        @SuppressWarnings("unchecked")
        List<String> modifiedFiles =
                (List<String>) state.value("modifiedFiles").orElse(List.of());
        archive.put("modifiedFiles", List.copyOf(modifiedFiles));

        // Execution journal — may be large, but critical for resume/repair
        Object journal = state.value("graphExecutionJournal").orElse(null);
        if (journal != null) {
            archive.put("graphExecutionJournal", journal);
        }

        // Session execution facts — compact, always included
        Object facts = state.value("sessionExecutionFacts").orElse(null);
        if (facts != null) {
            archive.put("sessionExecutionFacts", facts);
        }

        return archive;
    }
}