package io.codepilot.api.background;

import io.codepilot.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "background-agents", description = "Cloud background agent task registry")
@RestController
@RequestMapping(value = "/v1/background-agents", produces = MediaType.APPLICATION_JSON_VALUE)
public class BackgroundAgentsController {

  private static final Set<String> TERMINAL = Set.of("completed", "failed", "cancelled");
  private static final Map<String, Set<String>> TRANSITIONS =
      Map.of(
          "queued", Set.of("running", "cancelled"),
          "running", Set.of("completed", "failed", "cancelled", "needs_input"),
          "needs_input", Set.of("running", "cancelled", "failed"),
          "completed", Set.of(),
          "failed", Set.of(),
          "cancelled", Set.of());

  private final BackgroundAgentsStore store;

  public BackgroundAgentsController(BackgroundAgentsStore store) {
    this.store = store;
  }

  @Operation(summary = "Background task persistence backend (db or file)")
  @GetMapping("/status")
  public ApiResponse<Map<String, Object>> status() {
    return ApiResponse.ok(Map.of("backend", store.isDbBacked() ? "db" : "file"));
  }

  @Operation(summary = "List background tasks")
  @GetMapping
  public ApiResponse<List<Map<String, Object>>> list() {
    return ApiResponse.ok(store.all().values().stream().map(this::withId).toList());
  }

  @Operation(summary = "Create a background task record")
  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> create(@RequestBody @Valid CreateTaskRequest req) {
    String id = UUID.randomUUID().toString();
    Map<String, Object> task = new ConcurrentHashMap<>();
    task.put("id", id);
    task.put("title", req.title() != null && !req.title().isBlank() ? req.title() : "Background task");
    task.put("prompt", req.prompt());
    task.put("worktreePath", req.worktreePath() != null ? req.worktreePath() : "");
    task.put("localTaskId", req.localTaskId() != null ? req.localTaskId() : "");
    task.put("status", "queued");
    task.put("createdAt", Instant.now().toString());
    task.put("updatedAt", Instant.now().toString());
    store.put(id, task);
    return ApiResponse.ok(Map.of("taskId", id, "id", id, "status", "queued", "task", withId(task)));
  }

  @Operation(summary = "Get task status")
  @GetMapping("/{id}")
  public ApiResponse<Map<String, Object>> get(@PathVariable String id) {
    Map<String, Object> task = store.get(id);
    if (task == null) {
      return ApiResponse.ok(Map.of("found", false));
    }
    return ApiResponse.ok(Map.of("found", true, "task", withId(task)));
  }

  @Operation(summary = "Update task status (plugin sync)")
  @PatchMapping(value = "/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> patch(@PathVariable String id, @RequestBody Map<String, Object> body) {
    Map<String, Object> task = store.get(id);
    if (task == null) {
      return ApiResponse.ok(Map.of("ok", false, "error", "not_found"));
    }
    String current = String.valueOf(task.getOrDefault("status", "queued"));
    if (body.containsKey("status")) {
      String next = String.valueOf(body.get("status"));
      if (!canTransition(current, next)) {
        return ApiResponse.ok(Map.of("ok", false, "error", "invalid_transition", "from", current, "to", next));
      }
      task.put("status", next);
      if (TERMINAL.contains(next)) {
        task.put("endedAt", Instant.now().toString());
      }
    }
    if (body.containsKey("title")) {
      task.put("title", body.get("title"));
    }
    if (body.containsKey("outputs")) {
      task.put("outputs", body.get("outputs"));
    }
    task.put("updatedAt", Instant.now().toString());
    store.put(id, task);
    return ApiResponse.ok(Map.of("ok", true, "task", withId(task)));
  }

  @Operation(summary = "Cancel a background task")
  @DeleteMapping("/{id}")
  public ApiResponse<Map<String, Object>> cancel(@PathVariable String id) {
    Map<String, Object> task = store.get(id);
    if (task == null) {
      return ApiResponse.ok(Map.of("cancelled", false, "id", id));
    }
    String current = String.valueOf(task.getOrDefault("status", "queued"));
    if (!TERMINAL.contains(current)) {
      task.put("status", "cancelled");
      task.put("endedAt", Instant.now().toString());
      task.put("updatedAt", Instant.now().toString());
      store.put(id, task);
    }
    return ApiResponse.ok(Map.of("cancelled", true, "id", id, "status", task.get("status")));
  }

  private boolean canTransition(String from, String to) {
    if (from.equals(to)) return true;
    return TRANSITIONS.getOrDefault(from, Set.of()).contains(to);
  }

  private Map<String, Object> withId(Map<String, Object> task) {
    Map<String, Object> copy = new ConcurrentHashMap<>(task);
    copy.putIfAbsent("id", copy.get("id"));
    return copy;
  }

  public record CreateTaskRequest(
      @NotBlank String prompt,
      String worktreePath,
      String title,
      String localTaskId) {}
}
