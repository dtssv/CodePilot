package io.codepilot.core.model.dto;

import java.util.Map;

/** Command object for testing a model connection. */
public record TestModelCommand(
    String protocol,
    String baseUrl,
    String apiKey,
    String model,
    Map<String, String> headers,
    Integer timeoutMs) {}