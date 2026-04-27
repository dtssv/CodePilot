package io.codepilot.mcphub;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;

/**
 * Request body for install/uninstall/update operations.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InstallRequest(
    @NotBlank String slug,
    @NotBlank String version,
    /** "project" or "global". */
    @NotBlank String scope) {}