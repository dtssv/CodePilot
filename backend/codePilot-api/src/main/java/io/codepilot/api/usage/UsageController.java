package io.codepilot.api.usage;

import io.codepilot.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "usage", description = "Token usage aggregation and quota hints")
@RestController
@RequestMapping(value = "/v1/usage", produces = MediaType.APPLICATION_JSON_VALUE)
public class UsageController {

  private final UsagePersistenceStore store;

  public UsageController(UsagePersistenceStore store) {
    this.store = store;
  }

  @Operation(summary = "Record a usage event from plugin or gateway")
  @PostMapping(value = "/record", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> record(@RequestBody Map<String, Object> body) {
    body.putIfAbsent("ts", Instant.now().toEpochMilli());
    store.addRecord(body);
    return ApiResponse.ok(Map.of("ok", true, "persisted", true, "backend", store.isDbBacked() ? "db" : "file"));
  }

  @Operation(summary = "Aggregated usage by day, model, session")
  @GetMapping("/summary")
  public ApiResponse<Map<String, Object>> summary() {
    List<Map<String, Object>> records = store.records();
    return ApiResponse.ok(
        Map.of(
            "byDay", aggregate(records, this::dayKey),
            "byModel", aggregate(records, r -> String.valueOf(r.getOrDefault("modelId", "default"))),
            "bySession", aggregate(records, r -> String.valueOf(r.getOrDefault("sessionId", "unknown"))),
            "quotaWarnings", quotaWarnings(records),
            "recordCount", records.size(),
            "persisted", true,
            "backend", store.isDbBacked() ? "db" : "file"));
  }

  @Operation(summary = "Set daily quota ceiling (USD) for a user id")
  @PostMapping(value = "/quota", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> setQuota(@RequestBody Map<String, Object> body) {
    String userId = String.valueOf(body.getOrDefault("userId", "default"));
    double limit = ((Number) body.getOrDefault("dailyLimitUsd", 0)).doubleValue();
    store.setQuota(userId, limit);
    return ApiResponse.ok(Map.of("userId", userId, "dailyLimitUsd", limit));
  }

  private Map<String, Map<String, Object>> aggregate(
      List<Map<String, Object>> records, java.util.function.Function<Map<String, Object>, String> keyFn) {
    Map<String, Map<String, Object>> out = new ConcurrentHashMap<>();
    for (Map<String, Object> r : records) {
      String k = keyFn.apply(r);
      out.compute(
          k,
          (key, bucket) -> {
            Map<String, Object> b =
                bucket != null
                    ? bucket
                    : new ConcurrentHashMap<>(
                        Map.of("count", 0, "inputTokens", 0, "outputTokens", 0, "costUsd", 0.0));
            b.put("count", ((Number) b.get("count")).intValue() + 1);
            b.put("inputTokens", ((Number) b.get("inputTokens")).intValue() + intVal(r, "inputTokens"));
            b.put("outputTokens", ((Number) b.get("outputTokens")).intValue() + intVal(r, "outputTokens"));
            b.put("costUsd", ((Number) b.get("costUsd")).doubleValue() + doubleVal(r, "costUsd"));
            return b;
          });
    }
    return out;
  }

  private List<Map<String, Object>> quotaWarnings(List<Map<String, Object>> records) {
    String today = dayKey(Map.of("ts", Instant.now().toEpochMilli()));
    return store.dailyQuotaUsd().entrySet().stream()
        .filter(e -> e.getValue() > 0)
        .filter(
            e -> {
              double spent =
                  records.stream()
                      .filter(r -> dayKey(r).equals(today))
                      .mapToDouble(r -> doubleVal(r, "costUsd"))
                      .sum();
              return spent >= e.getValue() * 0.9;
            })
        .map(e -> Map.<String, Object>of("userId", e.getKey(), "dailyLimitUsd", e.getValue(), "warning", "approaching_quota"))
        .toList();
  }

  private static int intVal(Map<String, Object> r, String key) {
    Object v = r.get(key);
    return v instanceof Number n ? n.intValue() : 0;
  }

  private static double doubleVal(Map<String, Object> r, String key) {
    Object v = r.get(key);
    return v instanceof Number n ? n.doubleValue() : 0.0;
  }

  private String dayKey(Map<String, Object> r) {
    long ts = r.get("ts") instanceof Number n ? n.longValue() : Instant.now().toEpochMilli();
    return Instant.ofEpochMilli(ts).truncatedTo(ChronoUnit.DAYS).toString();
  }
}
