package io.codepilot.core.memory;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveRedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Persists and retrieves long-term project memories to/from Redis.
 *
 * <p>Key format: {@code memory:project:{projectRootHash}}
 * Each memory entry is stored as a JSON-serialized {@link StructuredMemory}
 * in a Redis Hash, keyed by the memory's ID.
 *
 * <p>TTL: 30 days (configurable). Memories are refreshed on read.
 *
 * <p>This store is used by:
 * <ul>
 *   <li>{@code MemoryLoadAction} — loads relevant project memories into graph state</li>
 *   <li>{@code FinalizeAction} — persists approved memory candidates to long-term storage</li>
 * </ul>
 */
@Component
public class ProjectMemoryStore {

    private static final Logger log = LoggerFactory.getLogger(ProjectMemoryStore.class);
    private static final Duration DEFAULT_TTL = Duration.ofDays(30);
    private static final String KEY_PREFIX = "memory:project:";
    /** Maximum memories per project (prevents unbounded growth). */
    private static final int MAX_MEMORIES_PER_PROJECT = 200;

    private final ReactiveRedisTemplate<String, String> template;
    private final ObjectMapper mapper;

    public ProjectMemoryStore(
            ReactiveRedisConnectionFactory connectionFactory,
            ObjectMapper mapper) {
        var serializer = new StringRedisSerializer();
        var ctx = RedisSerializationContext.<String, String>newSerializationContext(serializer)
                .key(serializer)
                .value(serializer)
                .hashKey(serializer)
                .hashValue(serializer)
                .build();
        this.template = new ReactiveRedisTemplate<>(connectionFactory, ctx);
        this.mapper = mapper;
    }

    /**
     * Load all memories for a project.
     *
     * @param projectRootHash the project root hash identifying the project
     * @return Mono of list of StructuredMemory entries
     */
    public Mono<List<StructuredMemory>> loadAll(String projectRootHash) {
        String key = KEY_PREFIX + projectRootHash;
        return template.opsForHash().values(key)
                .mapNotNull(json -> {
                    try {
                        return mapper.readValue((String) json, new TypeReference<Map<String, Object>>() {});
                    } catch (JsonProcessingException e) {
                        log.warn("Failed to parse memory entry: {}", e.getMessage());
                        return null;
                    }
                })
                .mapNotNull(map -> map != null ? StructuredMemory.fromMap(map) : null)
                .collectList()
                .doOnNext(list -> log.info("Loaded {} project memories for project={}", list.size(), projectRootHash));
    }

    /**
     * Load memories matching specific tags (semantic retrieval).
     * Returns memories whose tags overlap with the query tags.
     *
     * @param projectRootHash the project root hash
     * @param queryTags       tags to match against
     * @param limit           maximum number of memories to return
     * @return Mono of list of matching StructuredMemory entries, sorted by relevance
     */
    public Mono<List<StructuredMemory>> loadByTags(String projectRootHash, List<String> queryTags, int limit) {
        if (queryTags == null || queryTags.isEmpty()) {
            return loadAll(projectRootHash).map(list -> list.stream().limit(limit).toList());
        }
        Set<String> querySet = new HashSet<>(queryTags);
        return loadAll(projectRootHash).map(memories ->
                memories.stream()
                        .filter(m -> m.tags() != null && m.tags().stream().anyMatch(querySet::contains))
                        .sorted((a, b) -> {
                            // Sort by tag overlap count (descending), then by updatedAt (newest first)
                            long aOverlap = a.tags() != null ? a.tags().stream().filter(querySet::contains).count() : 0;
                            long bOverlap = b.tags() != null ? b.tags().stream().filter(querySet::contains).count() : 0;
                            if (bOverlap != aOverlap) return Long.compare(bOverlap, aOverlap);
                            return Long.compare(b.updatedAt(), a.updatedAt());
                        })
                        .limit(limit)
                        .toList()
        );
    }

    /**
     * Save a single memory entry to the project's long-term store.
     *
     * @param projectRootHash the project root hash
     * @param memory          the memory to save
     * @return Mono indicating save success
     */
    public Mono<Boolean> save(String projectRootHash, StructuredMemory memory) {
        String key = KEY_PREFIX + projectRootHash;
        try {
            String json = mapper.writeValueAsString(memory.toMap());
            return template.opsForHash().put(key, memory.id(), json)
                    .flatMap(saved -> {
                        if (Boolean.TRUE.equals(saved)) {
                            // Refresh TTL on every write
                            return template.expire(key, DEFAULT_TTL).thenReturn(true);
                        }
                        return Mono.just(false);
                    })
                    .doOnNext(saved -> log.info("Saved project memory: id={}, project={}, type={}",
                            memory.id(), projectRootHash, memory.type()));
        } catch (JsonProcessingException e) {
            return Mono.error(e);
        }
    }

    /**
     * Batch-save multiple memory entries.
     *
     * @param projectRootHash the project root hash
     * @param memories        the memories to save
     * @return Mono of count of saved entries
     */
    public Mono<Long> saveAll(String projectRootHash, List<StructuredMemory> memories) {
        if (memories == null || memories.isEmpty()) {
            return Mono.just(0L);
        }
        String key = KEY_PREFIX + projectRootHash;
        Map<String, String> entries = new LinkedHashMap<>();
        for (StructuredMemory m : memories) {
            try {
                entries.put(m.id(), mapper.writeValueAsString(m.toMap()));
            } catch (JsonProcessingException e) {
                log.warn("Failed to serialize memory {}: {}", m.id(), e.getMessage());
            }
        }
        if (entries.isEmpty()) {
            return Mono.just(0L);
        }
        return template.opsForHash().putAll(key, entries)
                .flatMap(v -> template.expire(key, DEFAULT_TTL).thenReturn((long) entries.size()))
                .doOnNext(count -> log.info("Batch-saved {} project memories for project={}", count, projectRootHash));
    }

    /**
     * Remove a specific memory entry.
     *
     * @param projectRootHash the project root hash
     * @param memoryId        the memory ID to remove
     * @return Mono indicating removal success
     */
    public Mono<Boolean> remove(String projectRootHash, String memoryId) {
        String key = KEY_PREFIX + projectRootHash;
        return template.opsForHash().remove(key, memoryId)
                .map(count -> count > 0)
                .doOnNext(removed -> log.info("Removed project memory: id={}, project={}", memoryId, projectRootHash));
    }

    /**
     * Mark a memory as superseded (soft delete — keeps history).
     *
     * @param projectRootHash the project root hash
     * @param memoryId        the memory ID to supersede
     * @return Mono indicating success
     */
    public Mono<Boolean> supersede(String projectRootHash, String memoryId) {
        return loadAll(projectRootHash)
                .flatMap(memories -> {
                    Optional<StructuredMemory> target = memories.stream()
                            .filter(m -> m.id().equals(memoryId))
                            .findFirst();
                    if (target.isEmpty()) return Mono.just(false);
                    StructuredMemory superseded = target.get().superseded();
                    return save(projectRootHash, superseded);
                });
    }

    /**
     * Get the count of memories for a project.
     */
    public Mono<Long> count(String projectRootHash) {
        String key = KEY_PREFIX + projectRootHash;
        return template.opsForHash().size(key);
    }
}