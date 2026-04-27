package io.codepilot.core.model;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Database entity for the custom_model table.
 *
 * <p>Maps 1:1 to the custom_model table. API key is stored encrypted (api_key_enc).
 */
public record CustomModelEntity(
    Long id,
    String userId,
    String name,
    String protocol,
    String baseUrl,
    String apiKeyEnc,
    String model,
    Map<String, String> headers,
    Integer timeoutMs,
    List<String> caps,
    Integer maxTokens,
    Instant createdAt,
    Instant updatedAt) {}