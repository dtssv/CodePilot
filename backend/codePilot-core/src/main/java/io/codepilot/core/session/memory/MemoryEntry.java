package io.codepilot.core.session.memory;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.Map;

/**
 * A single memory entry in the persistent memory store.
 *
 * <p>Memory types: PERSISTENT (MEMORY.md), SESSION (notes.md), CHECKPOINT
 * (checkpoint.md), DISTILLED (extracted from sessions).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class MemoryEntry {
  private String id;
  private String content;
  private MemoryType type;
  private String sessionId;
  private String projectId;
  private Instant createdAt;
  private Map<String, String> metadata;

  /**
   * Memory layers (4-layer model + scratchpad):
   *
   * <ul>
   *   <li>{@code PERSISTENT} — project memory (MEMORY.md), survives across sessions
   *   <li>{@code GLOBAL} — user-level preferences shared across all projects
   *   <li>{@code CHECKPOINT} — structured session checkpoint snapshot
   *   <li>{@code SESSION} — session-scoped knowledge
   *   <li>{@code NOTES} — free-form scratchpad the main agent may append to
   *   <li>{@code DISTILLED} — knowledge extracted from a finished session
   * </ul>
   */
  public enum MemoryType {
    PERSISTENT,
    GLOBAL,
    SESSION,
    CHECKPOINT,
    NOTES,
    DISTILLED;
  }

  // ── Getters ──
  public String getId() {
    return id;
  }

  public String getContent() {
    return content;
  }

  public MemoryType getType() {
    return type;
  }

  public String getSessionId() {
    return sessionId;
  }

  public String getProjectId() {
    return projectId;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Map<String, String> getMetadata() {
    return metadata;
  }

  // ── Builder-style setters ──
  public MemoryEntry setId(String id) {
    this.id = id;
    return this;
  }

  public MemoryEntry setContent(String content) {
    this.content = content;
    return this;
  }

  public MemoryEntry setType(MemoryType type) {
    this.type = type;
    return this;
  }

  public MemoryEntry setSessionId(String sessionId) {
    this.sessionId = sessionId;
    return this;
  }

  public MemoryEntry setProjectId(String projectId) {
    this.projectId = projectId;
    return this;
  }

  public MemoryEntry setCreatedAt(Instant createdAt) {
    this.createdAt = createdAt;
    return this;
  }

  public MemoryEntry setMetadata(Map<String, String> metadata) {
    this.metadata = metadata;
    return this;
  }

  public static MemoryEntry create(String content, MemoryType type) {
    MemoryEntry entry = new MemoryEntry();
    entry.content = content;
    entry.type = type;
    entry.createdAt = Instant.now();
    return entry;
  }
}
