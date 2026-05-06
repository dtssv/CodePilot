package io.codepilot.core.model;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/** Read-only projection of the custom_model_providers table (API key is never exposed). */
public record CustomModelProvider(
    UUID id,
    UUID userId,
    String name,
    String protocol,
    String baseUrl,
    String model,
    Map<String, String> headers,
    int timeoutMs,
    boolean enabled,
    Instant createdAt,
    Instant updatedAt) {}