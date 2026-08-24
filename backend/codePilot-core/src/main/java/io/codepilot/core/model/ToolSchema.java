package io.codepilot.core.model;

/**
 * Tool schema — mirrors harness-core's
 * {@code io.codepilot.harness.model.ToolSchema}.
 */
public record ToolSchema(String name, String description, String parametersJson) {}
