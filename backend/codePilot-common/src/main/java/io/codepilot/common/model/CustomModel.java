package io.codepilot.common.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;

/**
 * Represents a user-created custom model configuration.
 *
 * <p>Custom models use the OpenAI-compatible protocol and are stored in the database
 * with the API key encrypted.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CustomModel(
    /** Database-generated ID (prefixed with "u-"). */
    String id,
    /** Human-readable name. */
    @NotBlank String name,
    /** Protocol — currently only "openai" is supported. */
    @NotBlank String protocol,
    /** Provider base URL, e.g. "https://xxx.openai.azure.com/v1". */
    @NotBlank String baseUrl,
    /** Masked API key for display, e.g. "***ab12". Full key only on create/update input. */
    String apiKeyMask,
    /** Full API key — only present on create/update input, never returned in GET. */
    String apiKey,
    /** Model name to send in the request, e.g. "gpt-4o". */
    @NotBlank String model,
    /** Extra headers to include in each request. */
    Map<String, String> headers,
    /** Request timeout in milliseconds. */
    Integer timeoutMs,
    /** Capability flags inferred during test or manually set. */
    java.util.List<String> caps,
    /** Maximum context window tokens. */
    Integer maxTokens) {}