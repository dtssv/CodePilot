package io.codepilot.core.session.tool;

import io.codepilot.core.agent.tool.ToolCall;
import io.codepilot.core.agent.tool.ToolResult;

/**
 * Interface for tool executors.
 *
 * <p>Each tool has exactly one executor that validates the input and returns the tool result.
 */
public interface ToolExecutor {
  /** Execute the tool with the given arguments. */
  ToolResult execute(ToolCall call);

  /** Optional permission check before execution. */
  default boolean requiresPermission() {
    return false;
  }
}
