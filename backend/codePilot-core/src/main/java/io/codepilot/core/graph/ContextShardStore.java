package io.codepilot.core.graph;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.stream.Collectors;

/**
 * Stores and retrieves context shards (tagged fragments) in Redis.
 *
 * <p>For super-complex tasks, the accumulated context (user input, gathered code,
 * generated artifacts, analysis results) can far exceed what fits in a single LLM call.
 * This store enables splitting large context into labeled shards and retrieving only
 * the shards relevant to the current phase — regardless of whether the source is a
 * design document, codebase analysis, API specification, or any other large content.
 *
 * <h3>Key format:</h3>
 * {@code ctxshard:{projectRootHash}:{sourceId}}
 * Each shard is stored as a Redis Hash entry, keyed by shard ID.
 *
 * <h3>Shard structure:</h3>
 * <pre>
 * {
 *   "id": "user_table_entity",
 *   "sourceId": "input-ctx-1700000000",
 *   "tags": ["user", "entity", "table-definition"],
 *   "contentType": "table_definition",
 *   "content": "...",
 *   "metadata": { ... },
 *   "tokenEstimate": 450
 * }
 * </pre>
 *
 * <h3>Usage flow:</h3>
 * <ol>
 *   <li>ContextSplitAction: large input/context → split into shards → saveAll</li>
 *   <li>PhaseAwareMemoryLoader: at phase boundary → loadByTags → inject relevant shards</li>
 *   <li>GenerateAction/DynamicPlanExpandAction: load shards by phase tags → inject into prompt</li>
 * </ol>
 */
@Component
public class ContextShardStore {

    private static final Logger log = LoggerFactory.getLogger(ContextShardStore.class);
    private static final Duration DEFAULT_TTL = Duration.ofDays(7);
    private static final String KEY_PREFIX = "ctxshard:";

    private final ReactiveRedisTemplate<String, String> template;
    private final ObjectMapper mapper;

    public ContextShardStore(ReactiveRedisConnectionFactory connectionFactory,
                              ObjectMapper mapper) {
        var serializer = new StringRedisSerializer();
        var ctx = RedisSerializationContext.<String, String>newSerializationContext(serializer)
                .key(serializer).value(serializer)
                .hashKey(serializer).hashValue(serializer)
                .build();
        this.template = new ReactiveRedisTemplate<>(connectionFactory, ctx);
        this.mapper = mapper;
    }

    // ── Public API ──────────────────────────────────────────────

    /**
     * Save a single context shard.
     */
    public Mono<Boolean> save(String projectRootHash, ContextShard shard) {
        String key = redisKey(projectRootHash, shard.sourceId);
        try {
            String json = mapper.writeValueAsString(shard.toMap());
            return template.opsForHash().put(key, shard.id, json)
                    .flatMap(saved -> {
                        if (Boolean.TRUE.equals(saved)) {
                            return template.expire(key, DEFAULT_TTL).thenReturn(true);
                        }
                        return Mono.just(false);
                    })
                    .doOnNext(s -> log.debug("Saved shard: id={}, source={}, project={}",
                            shard.id, shard.sourceId, projectRootHash));
        } catch (JsonProcessingException e) {
            return Mono.error(e);
        }
    }

    /**
     * Batch-save multiple shards for the same source.
     */
    public Mono<Long> saveAll(String projectRootHash, String sourceId, List<ContextShard> shards) {
        if (shards == null || shards.isEmpty()) return Mono.just(0L);
        String key = redisKey(projectRootHash, sourceId);
        Map<String, String> entries = new LinkedHashMap<>();
        for (ContextShard s : shards) {
            try {
                entries.put(s.id, mapper.writeValueAsString(s.toMap()));
            } catch (JsonProcessingException e) {
                log.warn("Failed to serialize shard {}: {}", s.id, e.getMessage());
            }
        }
        if (entries.isEmpty()) return Mono.just(0L);
        return template.opsForHash().putAll(key, entries)
                .flatMap(v -> template.expire(key, DEFAULT_TTL).thenReturn((long) entries.size()))
                .doOnNext(count -> log.info("Batch-saved {} shards for source={}, project={}",
                        count, sourceId, projectRootHash));
    }

    /**
     * Load all shards for a source.
     */
    public Mono<List<ContextShard>> loadAll(String projectRootHash, String sourceId) {
        String key = redisKey(projectRootHash, sourceId);
        return template.opsForHash().values(key)
                .mapNotNull(json -> deserializeShard((String) json))
                .collectList();
    }

    /**
     * Load shards matching specific tags (semantic retrieval) — convenience overload
     * with no limit (returns all matching shards).
     */
    public Mono<List<ContextShard>> loadByTags(String projectRootHash,
                                                String sourceId,
                                                List<String> queryTags) {
        return loadByTags(projectRootHash, sourceId, queryTags, Integer.MAX_VALUE);
    }

    /**
     * Load shards matching specific tags (semantic retrieval).
     * Returns shards whose tags overlap with the query tags, sorted by relevance.
     */
    public Mono<List<ContextShard>> loadByTags(String projectRootHash,
                                                String sourceId,
                                                List<String> queryTags,
                                                int limit) {
        if (queryTags == null || queryTags.isEmpty()) {
            return loadAll(projectRootHash, sourceId)
                    .map(list -> list.stream().limit(limit).toList());
        }
        Set<String> querySet = new HashSet<>(queryTags);
        return loadAll(projectRootHash, sourceId).map(shards ->
                shards.stream()
                        .filter(s -> s.tags != null && s.tags.stream().anyMatch(querySet::contains))
                        .sorted((a, b) -> {
                            long aOverlap = a.tags != null ? a.tags.stream().filter(querySet::contains).count() : 0;
                            long bOverlap = b.tags != null ? b.tags.stream().filter(querySet::contains).count() : 0;
                            if (bOverlap != aOverlap) return Long.compare(bOverlap, aOverlap);
                            return Long.compare(b.tokenEstimate, a.tokenEstimate);
                        })
                        .limit(limit)
                        .toList()
        );
    }

    /**
     * Remove all shards for a source.
     */
    public Mono<Boolean> removeSource(String projectRootHash, String sourceId) {
        String key = redisKey(projectRootHash, sourceId);
        return template.delete(key).map(count -> count > 0);
    }

    // ── Helpers ──────────────────────────────────────────────────

    private String redisKey(String projectRootHash, String sourceId) {
        return KEY_PREFIX + projectRootHash + ":" + sourceId;
    }

    private ContextShard deserializeShard(String json) {
        try {
            Map<String, Object> map = mapper.readValue(json, new TypeReference<>() {});
            return ContextShard.fromMap(map);
        } catch (JsonProcessingException e) {
            log.warn("Failed to deserialize shard: {}", e.getMessage());
            return null;
        }
    }

    // ── Data Class ──────────────────────────────────────────────

    /**
     * A single shard (fragment) of a large context.
     *
     * @param id            unique shard identifier
     * @param sourceId      parent source identifier (e.g., "input-ctx-1700000000")
     * @param tags          semantic tags for retrieval — LLM decides these
     * @param contentType   content type hint (e.g., "specification", "code_reference")
     * @param content       the actual text content of this shard
     * @param summary       concise summary of this shard's content (LLM-generated at split time);
     *                      used when the full content exceeds budget, allowing downstream nodes
     *                      to inject summary instead of truncating or dropping the shard entirely.
     *                      When loading a historical session with compacted context, this summary
     *                      serves as the authoritative context source instead of re-loading the
     *                      full conversation history.
     * @param metadata      additional structured metadata
     * @param tokenEstimate estimated token count for budget management
     */
    public record ContextShard(
            String id,
            String sourceId,
            List<String> tags,
            String contentType,
            String content,
            String summary,
            Map<String, Object> metadata,
            int tokenEstimate
    ) {
        /** Convenience constructor without summary (backward compat for manually created shards). */
        public ContextShard(String id, String sourceId, List<String> tags,
                            String contentType, String content,
                            Map<String, Object> metadata, int tokenEstimate) {
            this(id, sourceId, tags, contentType, content, "", metadata, tokenEstimate);
        }

        public Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", id);
            map.put("sourceId", sourceId);
            map.put("tags", tags);
            map.put("contentType", contentType);
            map.put("content", content);
            map.put("summary", summary);
            map.put("metadata", metadata);
            map.put("tokenEstimate", tokenEstimate);
            return map;
        }

        @SuppressWarnings("unchecked")
        public static ContextShard fromMap(Map<String, Object> map) {
            return new ContextShard(
                    (String) map.getOrDefault("id", ""),
                    (String) map.getOrDefault("sourceId", map.getOrDefault("documentId", "")),
                    (List<String>) map.getOrDefault("tags", List.of()),
                    (String) map.getOrDefault("contentType", ""),
                    (String) map.getOrDefault("content", ""),
                    (String) map.getOrDefault("summary", ""),
                    (Map<String, Object>) map.getOrDefault("metadata", Map.of()),
                    map.get("tokenEstimate") instanceof Number n ? n.intValue() : 0
            );
        }
    }
}