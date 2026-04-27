package io.codepilot.common.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;

/**
 * Request body for POST /v1/models/test — test connectivity before saving.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ModelTestRequest(
    @NotBlank String protocol,
    @NotBlank String baseUrl,
    @NotBlank String apiKey,
    @NotBlank String model,
    Map<String, String> headers,
    Integer timeoutMs) {}