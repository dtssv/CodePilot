package io.codepilot.core.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Read-only projection of the model_app_keys table. An app key is an individual API key under a
 * model group, used for load balancing across multiple keys. The actual API key cipher is never
 * exposed to the client.
 *
 * @param maxConcurrency maximum concurrent requests (0 = unlimited)
 * @param rpmLimit requests-per-minute limit (0 = unlimited)
 * @param tpmLimit tokens-per-minute limit (0 = unlimited)
 * @param priority higher value = preferred when loads are equal
 */
public record ModelAppKey(
    UUID id,
    UUID groupId,
    String name,
    String baseUrl,
    int weight,
    int maxConcurrency,
    int rpmLimit,
    int tpmLimit,
    int priority,
    boolean enabled,
    Instant createdAt,
    Instant updatedAt) {}
