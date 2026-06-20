package io.codepilot.core.task;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

/**
 * A task in the tree-shaped task tracking system. System: T1, T1.1, T1.2,
 * etc.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskInfo(
    @JsonProperty("id") String id,
    @JsonProperty("parentId") String parentId,
    @JsonProperty("sessionId") String sessionId,
    @JsonProperty("title") String title,
    @JsonProperty("description") String description,
    @JsonProperty("status") Status status,
    @JsonProperty("createdAt") Instant createdAt,
    @JsonProperty("updatedAt") Instant updatedAt) {

  public enum Status {
    @JsonProperty("pending")
    PENDING,
    @JsonProperty("in_progress")
    IN_PROGRESS,
    @JsonProperty("completed")
    COMPLETED,
    @JsonProperty("failed")
    FAILED
  }

  /** Generate a task ID in the tree format: T1, T1.1, T1.2, etc. */
  public static String generateId(String parentId, int siblingIndex) {
    if (parentId == null || parentId.isBlank()) {
      return "T" + siblingIndex;
    }
    return parentId + "." + siblingIndex;
  }

  public TaskInfo withStatus(Status newStatus) {
    return new TaskInfo(
        id, parentId, sessionId, title, description, newStatus, createdAt, Instant.now());
  }
}
