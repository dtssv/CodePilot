package io.codepilot.core.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.ConversationRunRequest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.UUID;

/**
 * Loads and saves {@link GraphState} from/to Redis with 24h TTL.
 * The plugin-side plans/graph-{n}.json is the ultimate authority;
 * this store is a convenience cache for the current run.
 */
@Component
public class GraphStateStore {

    private static final Duration TTL = Duration.ofHours(24);
    private static final String KEY_PREFIX = "graph:state:";

    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;

    public GraphStateStore(StringRedisTemplate redis, ObjectMapper mapper) {
        this.redis = redis;
        this.mapper = mapper;
    }

    public GraphState loadOrInit(ConversationRunRequest request) {
        String key = KEY_PREFIX + request.sessionId();
        String json = redis.opsForValue().get(key);
        if (json != null) {
            try {
                return mapper.readValue(json, GraphState.class);
            } catch (Exception ignored) {}
        }
        // Initialize new state
        GraphState state = new GraphState();
        state.setSessionId(request.sessionId());
        state.setGraphId("gph-" + UUID.randomUUID().toString().substring(0, 8));
        // If request carries a graphState from plugin (resume), use it
        if (request.graphState() != null) {
            try {
                return mapper.convertValue(request.graphState(), GraphState.class);
            } catch (Exception ignored) {}
        }
        return state;
    }

    public void save(String sessionId, GraphState state) {
        try {
            String json = mapper.writeValueAsString(state);
            redis.opsForValue().set(KEY_PREFIX + sessionId, json, TTL);
        } catch (Exception ignored) {}
    }
}