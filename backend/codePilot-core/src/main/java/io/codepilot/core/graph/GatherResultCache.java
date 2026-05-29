package io.codepilot.core.graph;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import io.codepilot.core.run.GraphEngineProperties;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Session-scoped cache for idempotent server-side gather tools ({@code rag.search}, {@code http.fetch}). */
@Component
public class GatherResultCache {

    private static final Logger log = LoggerFactory.getLogger(GatherResultCache.class);
    private static final Set<String> CACHEABLE_KINDS = Set.of("rag.search", "http.fetch");

    private final ObjectMapper mapper;
    private final Cache<String, Map<String, Object>> cache;

    public GatherResultCache(ObjectMapper mapper, GraphEngineProperties graphProperties) {
        this.mapper = mapper;
        int ttlMinutes =
                graphProperties.getGatherCacheTtlMinutes() > 0
                        ? graphProperties.getGatherCacheTtlMinutes()
                        : 30;
        int maxEntries =
                graphProperties.getGatherCacheMaxEntries() > 0
                        ? graphProperties.getGatherCacheMaxEntries()
                        : 512;
        this.cache =
                Caffeine.newBuilder()
                        .expireAfterWrite(Duration.ofMinutes(ttlMinutes))
                        .maximumSize(maxEntries)
                        .build();
    }

    public boolean isCacheable(String kind) {
        return kind != null && CACHEABLE_KINDS.contains(kind);
    }

    public Optional<Map<String, Object>> get(
            String kind, Map<String, Object> args, String projectRootHash) {
        if (!isCacheable(kind)) {
            return Optional.empty();
        }
        Map<String, Object> hit = cache.getIfPresent(cacheKey(kind, args, projectRootHash));
        return Optional.ofNullable(hit);
    }

    public void put(
            String kind,
            Map<String, Object> args,
            String projectRootHash,
            Map<String, Object> resultEntry) {
        if (!isCacheable(kind) || resultEntry == null) {
            return;
        }
        if (!Boolean.TRUE.equals(resultEntry.get("ok"))) {
            return;
        }
        cache.put(cacheKey(kind, args, projectRootHash), Map.copyOf(resultEntry));
    }

    private String cacheKey(String kind, Map<String, Object> args, String projectRootHash) {
        String scope = projectRootHash != null && !projectRootHash.isBlank() ? projectRootHash : "_";
        return scope + "|" + kind + "|" + stableArgsHash(args);
    }

    private String stableArgsHash(Map<String, Object> args) {
        if (args == null || args.isEmpty()) {
            return "0";
        }
        try {
            TreeMap<String, Object> sorted = new TreeMap<>();
            sorted.putAll(args);
            String json = mapper.writeValueAsString(sorted);
            return Integer.toHexString(Objects.hash(json));
        } catch (JsonProcessingException e) {
            return Integer.toHexString(Objects.hash(args.toString()));
        }
    }
}
