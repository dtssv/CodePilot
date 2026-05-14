package io.codepilot.core.graph;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveRedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.Map;

/**
 * Persists and restores Graph state snapshots to/from Redis for the
 * interrupt-resume mechanism.
 *
 * <p>When the graph hits an interrupt point (askUser, awaitUserInput),
 * the full {@link com.alibaba.cloud.ai.graph.OverAllState} is snapshotted
 * and stored in Redis keyed by {@code continuationToken}. On resume,
 * the snapshot is loaded and the graph resumes from the interrupt point's
 * next node.
 *
 * <p>Key format: {@code graph:checkpoint:{continuationToken}}
 * TTL: 24 hours (configurable)
 */
@Component
public class GraphCheckpointStore {

    private static final Logger log = LoggerFactory.getLogger(GraphCheckpointStore.class);
    private static final Duration DEFAULT_TTL = Duration.ofHours(24);
    private static final String KEY_PREFIX = "graph:checkpoint:";

    private final ReactiveRedisTemplate<String, String> template;
    private final ObjectMapper mapper;

    public GraphCheckpointStore(
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
     * Saves a graph state snapshot keyed by continuationToken.
     *
     * @param continuationToken unique token identifying this interrupt point
     * @param stateData         the full graph state data to persist
     * @param nextNode          the node to resume execution from
     * @return Mono indicating save success
     */
    public Mono<Boolean> save(String continuationToken, Map<String, Object> stateData, String nextNode) {
        String key = KEY_PREFIX + continuationToken;
        CheckpointSnapshot snapshot = new CheckpointSnapshot(
                continuationToken,
                nextNode,
                stateData,
                System.currentTimeMillis()
        );
        String json;
        try {
            json = mapper.writeValueAsString(snapshot);
        } catch (JsonProcessingException e) {
            return Mono.error(e);
        }
        log.info("Saving graph checkpoint: token={}, nextNode={}, stateKeys={}",
                continuationToken, nextNode, stateData.keySet());
        return template.opsForValue().set(key, json, DEFAULT_TTL);
    }

    /**
     * Loads a graph state snapshot by continuationToken.
     *
     * @param continuationToken the token from the resume request
     * @return Mono of CheckpointSnapshot, or empty if not found/expired
     */
    public Mono<CheckpointSnapshot> load(String continuationToken) {
        String key = KEY_PREFIX + continuationToken;
        return template.opsForValue().get(key)
                .mapNotNull(json -> {
                    try {
                        return mapper.readValue(json, CheckpointSnapshot.class);
                    } catch (JsonProcessingException e) {
                        log.error("Failed to parse checkpoint for token={}: {}", continuationToken, e.getMessage());
                        return null;
                    }
                })
                .doOnNext(snap -> log.info("Loaded graph checkpoint: token={}, nextNode={}, savedAt={}",
                        snap.continuationToken(), snap.nextNode(), snap.savedAt()));
    }

    /**
     * Removes a checkpoint after successful resume (cleanup).
     */
    public Mono<Boolean> remove(String continuationToken) {
        String key = KEY_PREFIX + continuationToken;
        return template.delete(key).map(count -> count > 0);
    }

    /**
     * Serialized checkpoint snapshot stored in Redis.
     */
    public record CheckpointSnapshot(
            String continuationToken,
            String nextNode,
            Map<String, Object> stateData,
            long savedAt
    ) {}
}