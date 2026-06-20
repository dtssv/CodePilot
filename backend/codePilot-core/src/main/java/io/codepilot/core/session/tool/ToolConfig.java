package io.codepilot.core.session.tool;

import io.codepilot.core.mcp.McpToolBridge;
import io.codepilot.core.session.memory.MemoryTool;
import io.codepilot.core.skill.SkillTool;
import io.codepilot.core.task.TaskCreateTool;
import io.codepilot.core.task.TaskListTool;
import io.codepilot.core.task.TaskUpdateTool;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Spring configuration for tool system beans.
 *
 * <p>Registers all built-in tools into the ToolRegistry. Tools are classified as REMOTE
 * (plugin-executed) or LOCAL (backend-executed).
 */
@Configuration
public class ToolConfig {

  @Bean
  public ToolRegistry toolRegistry(
      // ── File read tools (REMOTE — read-only, plugin executes) ──
      FileReadTool fileReadTool,
      FileListTool fileListTool,
      FileSearchTool fileSearchTool,
      FileGrepTool fileGrepTool,
      FileOutlineTool fileOutlineTool,
      // ── File write tools (REMOTE — mutating, plugin executes) ──
      FileWriteTool fileWriteTool,
      FileCreateTool fileCreateTool,
      FileReplaceTool fileReplaceTool,
      FileDeleteTool fileDeleteTool,
      FileMoveTool fileMoveTool,
      FileApplyPatchTool fileApplyPatchTool,
      // ── Shell tools (REMOTE — plugin executes) ──
      ShellExecTool shellExecTool,
      ShellSessionTool shellSessionTool,
      // ── Code intelligence tools (REMOTE — plugin executes via IDE) ──
      CodeOutlineTool codeOutlineTool,
      CodeSymbolTool codeSymbolTool,
      CodeUsagesTool codeUsagesTool,
      // ── IDE tools (REMOTE — plugin executes via IDE) ──
      IdeOpenFileTool ideOpenFileTool,
      IdeDiagnosticsTool ideDiagnosticsTool,
      IdeApplyPatchTool ideApplyPatchTool,
      IdeShadowValidateTool ideShadowValidateTool,
      // ── Interactive tools (REMOTE) ──
      AskUserTool askUserTool,
      // ── Notepad tools (REMOTE — session-scoped working memory) ──
      NotepadWriteTool notepadWriteTool,
      NotepadReadTool notepadReadTool,
      // ── VCS tools (REMOTE — plugin executes git) ──
      CommitTool commitTool,
      // ── Memory & Skill & Task tools (LOCAL — backend executes) ──
      MemoryTool memoryTool,
      SkillTool skillTool,
      TaskCreateTool taskCreateTool,
      TaskUpdateTool taskUpdateTool,
      TaskListTool taskListTool,
      TaskSubagentTool taskSubagentTool,
      // ── MCP tools (REMOTE — plugin relays to the MCP server) ──
      List<McpToolBridge> mcpToolBridges) {

    ToolRegistry registry = new ToolRegistry();

    // ── File read tools (REMOTE, read-only) ──
    registry.register(fileReadTool.definition(), fileReadTool.executor(), true);
    registry.register(fileListTool.definition(), fileListTool.executor(), true);
    registry.register(fileSearchTool.definition(), fileSearchTool.executor(), true);
    registry.register(fileGrepTool.definition(), fileGrepTool.executor(), true);
    registry.register(fileOutlineTool.definition(), fileOutlineTool.executor(), true);

    // ── File write tools (REMOTE, mutating) ──
    registry.register(fileWriteTool.definition(), fileWriteTool.executor(), true);
    registry.register(fileCreateTool.definition(), fileCreateTool.executor(), true);
    registry.register(fileReplaceTool.definition(), fileReplaceTool.executor(), true);
    registry.register(fileDeleteTool.definition(), fileDeleteTool.executor(), true);
    registry.register(fileMoveTool.definition(), fileMoveTool.executor(), true);
    registry.register(fileApplyPatchTool.definition(), fileApplyPatchTool.executor(), true);

    // ── Shell tools (REMOTE) ──
    registry.register(shellExecTool.definition(), shellExecTool.executor(), true);
    registry.register(shellSessionTool.definition(), shellSessionTool.executor(), true);

    // ── Code intelligence tools (REMOTE, read-only) ──
    registry.register(codeOutlineTool.definition(), codeOutlineTool.executor(), true);
    registry.register(codeSymbolTool.definition(), codeSymbolTool.executor(), true);
    registry.register(codeUsagesTool.definition(), codeUsagesTool.executor(), true);

    // ── IDE tools (REMOTE) ──
    registry.register(ideOpenFileTool.definition(), ideOpenFileTool.executor(), true);
    registry.register(ideDiagnosticsTool.definition(), ideDiagnosticsTool.executor(), true);
    registry.register(ideApplyPatchTool.definition(), ideApplyPatchTool.executor(), true);
    registry.register(ideShadowValidateTool.definition(), ideShadowValidateTool.executor(), true);

    // ── Interactive tools (REMOTE) ──
    registry.register(askUserTool.definition(), askUserTool.executor(), true);

    // ── Notepad tools (REMOTE, read/write) ──
    registry.register(notepadWriteTool.definition(), notepadWriteTool.executor(), true);
    registry.register(notepadReadTool.definition(), notepadReadTool.executor(), true);

    // ── VCS tools (REMOTE, mutating) ──
    registry.register(commitTool.definition(), commitTool.executor(), true);

    // ── Memory tools (LOCAL) ──
    registry.register(memoryTool.definition(), memoryTool.executor());

    // ── Skill tools (LOCAL) ──
    registry.register(skillTool.definition(), skillTool.executor());

    // ── Task tools (LOCAL) ──
    registry.register(taskCreateTool.definition(), taskCreateTool.executor());
    registry.register(taskUpdateTool.definition(), taskUpdateTool.executor());
    registry.register(taskListTool.definition(), taskListTool.executor());
    registry.register(taskSubagentTool.definition(), taskSubagentTool.executor());

    // ── MCP tools (REMOTE) ──
    for (McpToolBridge bridge : mcpToolBridges) {
      registry.register(bridge.definition(), bridge.executor(), true);
    }

    return registry;
  }

  /**
   * MCP tool bridges are created dynamically from the plugin's tool list. This bean provides an
   * empty list as default — the actual bridges are registered per-session when the plugin sends its
   * MCP tool definitions.
   */
  @Bean
  public List<McpToolBridge> mcpToolBridges() {
    return List.of();
  }
}
