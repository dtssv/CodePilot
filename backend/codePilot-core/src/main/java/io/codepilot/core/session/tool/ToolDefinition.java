package io.codepilot.core.session.tool;

import java.util.Map;

/**
 * Clean tool definition — schema-driven, replaces the old {@code ToolDefinition} and builder
 * pattern. The model will receive these as JSON Schema definitions.
 */
public record ToolDefinition(
    /** Unique tool name (e.g. "fs.read", "shell.exec"). */
    String name,
    /** Human-readable description of what the tool does. */
    String description,
    /** JSON Schema for the tool's input parameters. */
    Map<String, Object> parametersSchema,
    /** Whether this tool modifies state (vs. read-only). */
    boolean readOnly,
    /** Whether this tool requires user confirmation before execution. */
    boolean requiresPermission) {}
