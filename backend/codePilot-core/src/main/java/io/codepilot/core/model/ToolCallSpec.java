package io.codepilot.core.model;

/**
 * Tool call spec — mirrors harness-core's
 * {@code io.codepilot.harness.model.ToolCallSpec}.
 */
public record ToolCallSpec(String id, String name, String argumentsJson) {}
