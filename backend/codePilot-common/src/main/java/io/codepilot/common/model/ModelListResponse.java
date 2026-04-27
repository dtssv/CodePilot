package io.codepilot.common.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Response for GET /v1/models — returns both built-in and custom models.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ModelListResponse(
    List<BuiltinModel> builtin,
    List<CustomModel> custom) {}