package io.codepilot.core.model.dto;

import java.util.Map;

/** Command object for updating a custom model provider. */
public record UpdateModelCommand(
    String name,
    String protocol,
    String baseUrl,
    String apiKey,
    String model,
    Map<String, String> headers,
    Integer timeoutMs,
    Boolean enabled) {}
