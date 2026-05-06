package io.codepilot.core.model.dto;

import java.util.Map;
import java.util.UUID;

/** Command object for creating a custom model provider. */
public record CreateModelCommand(
    UUID userId,
    String name,
    String protocol,
    String baseUrl,
    String apiKey,
    String model,
    Map<String, String> headers,
    Integer timeoutMs) {}