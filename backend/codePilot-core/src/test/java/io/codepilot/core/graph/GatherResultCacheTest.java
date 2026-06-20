package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.run.GraphEngineProperties;
import java.util.Map;
import org.junit.jupiter.api.Test;

class GatherResultCacheTest {

    @Test
    void cachesSuccessfulServerSideResults() {
        var props = new GraphEngineProperties();
        props.setGatherCacheTtlMinutes(10);
        props.setGatherCacheMaxEntries(16);
        var cache = new GatherResultCache(new ObjectMapper(), props);

        Map<String, Object> args = Map.of("query", "auth flow");
        Map<String, Object> entry =
                Map.of(
                        "id",
                        "req-1",
                        "kind",
                        "rag.search",
                        "ok",
                        true,
                        "result",
                        Map.of("hits", 3));

        cache.put("rag.search", args, "proj-hash", entry);

        assertThat(cache.get("rag.search", args, "proj-hash")).isPresent();
        assertThat(cache.get("rag.search", args, "other-proj")).isEmpty();
        assertThat(cache.get("fs.read", args, "proj-hash")).isEmpty();
    }

    @Test
    void doesNotCacheFailedResults() {
        var cache = new GatherResultCache(new ObjectMapper(), new GraphEngineProperties());
        Map<String, Object> args = Map.of("url", "https://example.com");
        cache.put(
                "http.fetch",
                args,
                "proj",
                Map.of("id", "x", "kind", "http.fetch", "ok", false, "errorMessage", "timeout"));
        assertThat(cache.get("http.fetch", args, "proj")).isEmpty();
    }
}
