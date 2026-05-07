package io.codepilot.core.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Read-only projection of the system_model_providers table.
 * System models are configured by administrators and available to all users.
 * API key is never exposed to the client.
 */
public record SystemModelProvider(
    UUID id,
    String name,
    String protocol,
    String baseUrl,
    String model,
    List<String> capabilities,
    int maxTokens,
    int timeoutMs,
    boolean enabled,
    int sortOrder,
    Instant createdAt,
    Instant updatedAt) {}