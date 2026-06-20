package io.codepilot.core.session.tool;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tool registry — manages all registered tools.
 *
 * <p>Replaces the old {@code ToolSchemaRegistry} with a cleaner design where each tool is
 * registered with its definition and executor together.
 */
public class ToolRegistry {

  private final Map<String, ToolEntry> tools = new ConcurrentHashMap<>();

  /** Register a LOCAL tool (executed directly by the backend). */
  public void register(ToolDefinition definition, ToolExecutor executor) {
    register(definition, executor, false);
  }

  /**
   * Register a tool with its definition, executor, and execution site.
   *
   * @param remote {@code true} if the tool must be executed by the plugin against the user's
   *     workspace (file/shell/MCP); {@code false} for backend-local tools (memory/skill/task).
   */
  public void register(ToolDefinition definition, ToolExecutor executor, boolean remote) {
    tools.put(definition.name(), new ToolEntry(definition, executor, remote));
  }

  /** Whether the named tool must be dispatched to the plugin for execution. */
  public boolean isRemote(String name) {
    ToolEntry entry = tools.get(name);
    return entry != null && entry.remote();
  }

  /** Get the tool definition by name. */
  public Optional<ToolDefinition> getDefinition(String name) {
    ToolEntry entry = tools.get(name);
    return entry == null ? Optional.empty() : Optional.of(entry.definition());
  }

  /** Get the executor for a tool by name. */
  public Optional<ToolExecutor> getExecutor(String name) {
    ToolEntry entry = tools.get(name);
    return entry == null ? Optional.empty() : Optional.of(entry.executor());
  }

  /** Get all registered tool definitions. */
  public List<ToolDefinition> getDefinitions() {
    return new ArrayList<>(tools.values()).stream().map(ToolEntry::definition).toList();
  }

  /** Get all registered tools. */
  public Map<String, ToolEntry> getAll() {
    return Map.copyOf(tools);
  }

  /** Internal record for a registered tool. */
  record ToolEntry(ToolDefinition definition, ToolExecutor executor, boolean remote) {}
}
