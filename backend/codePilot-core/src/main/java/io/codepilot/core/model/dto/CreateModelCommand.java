package io.codepilot.core.model.dto;

import java.util.Map;

/** Command object for creating a custom model provider. */
public record CreateModelCommand(
    String userId,
    String name,
    String protocol,
    String baseUrl,
    String apiKey,
    String model,
    Map<String, String> headers,
    Integer timeoutMs) {}
