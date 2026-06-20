package io.codepilot.core.agent.tool;

/**
 * Clean result wrapper for tool execution.
 *
 * <p>Replaces the old {@code ToolDefinition} / {@code ServerToolExecutor} pattern with a simpler
 * result type.
 */
public record ToolResult(boolean success, String output) {}
