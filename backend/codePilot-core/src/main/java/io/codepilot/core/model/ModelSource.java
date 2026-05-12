package io.codepilot.core.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Indicates the source/category of a model ID passed in a request.
 *
 * <p>When a client passes a {@code modelId}, it may refer to either:
 * <ul>
 *   <li>{@link #GROUP} — a system model group ({@code model_groups} table)</li>
 *   <li>{@link #CUSTOM} — a user-level custom model ({@code custom_model_providers} table)</li>
 * </ul>
 *
 * <p>This allows {@link ChatClientFactory#resolve(String, ModelSource)} to directly
 * target the correct resolution path instead of trying both tables.
 */
public enum ModelSource {
  /** Model group (system-level, in model_groups table with load balancing). */
  @JsonProperty("group") GROUP,

  /** Custom model (user-level, in custom_model_providers table). */
  @JsonProperty("custom") CUSTOM
}