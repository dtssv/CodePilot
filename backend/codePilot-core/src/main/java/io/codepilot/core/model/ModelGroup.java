package io.codepilot.core.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Read-only projection of the model_groups table.
 * A model group represents a logical model visible to users (e.g. "glm-5.1"),
 * which may contain multiple API keys for load balancing.
 */
public record ModelGroup(
    UUID id,
    String name,
    String protocol,
    String model,
    String baseUrl,
    List<String> capabilities,
    int maxTokens,
    int timeoutMs,
    boolean enabled,
    int sortOrder,
    Instant createdAt,
    Instant updatedAt) {}