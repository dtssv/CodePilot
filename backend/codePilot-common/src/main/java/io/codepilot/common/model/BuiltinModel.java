package io.codepilot.common.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Represents a built-in model shipped with the CodePilot platform.
 *
 * <p>Configured via application yaml; not user-editable.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record BuiltinModel(
    /** Stable identifier, e.g. "codePilot-default". */
    String id,
    /** Human-readable name. */
    String name,
    /** Capability flags: "tools", "stream", "vision", etc. */
    List<String> caps,
    /** Maximum context window in tokens. */
    int maxTokens) {}