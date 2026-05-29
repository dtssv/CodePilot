package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.prompt.PromptRegistry;
import io.codepilot.core.tool.ToolSchemaRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Uses a small LLM call to infer tool/plan needs from user intent (any language). */
@Component
public class IntakeIntentClassifier {

  private static final Logger log = LoggerFactory.getLogger(IntakeIntentClassifier.class);

  private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
  private final PromptRegistry promptRegistry;
  private final ToolSchemaRegistry toolSchemaRegistry;
  private final ObjectMapper mapper;

  public IntakeIntentClassifier(
      GraphAuxiliaryModelResolver auxiliaryModelResolver,
      PromptRegistry promptRegistry,
      ToolSchemaRegistry toolSchemaRegistry,
      ObjectMapper mapper) {
    this.auxiliaryModelResolver = auxiliaryModelResolver;
    this.promptRegistry = promptRegistry;
    this.toolSchemaRegistry = toolSchemaRegistry;
    this.mapper = mapper;
  }

  public IntakeIntent classify(OverAllState state, String input, String mode) {
    if (input == null || input.isBlank()) {
      return IntakeIntent.defaults();
    }
    try {
      String projectMeta = (String) state.value("projectMeta").orElse("");
      String projectMetaSection =
          projectMeta.isBlank() ? "" : "[PROJECT CONTEXT]\n" + projectMeta + "\n";

      @SuppressWarnings("unchecked")
      List<Map<String, Object>> mcpTools =
          (List<Map<String, Object>>) state.value("mcpTools").orElse(List.of());

      String prompt =
          promptRegistry
              .get("graph.intake")
              .replace("{{projectMeta}}", projectMetaSection)
              .replace("{{input}}", input)
              .replace("{{mode}}", mode != null ? mode : "AGENT")
              .replace("{{toolCatalog}}", toolSchemaRegistry.renderCatalogBrief())
              .replace("{{mcpTools}}", formatMcpToolsSection(mcpTools));

      String response = auxiliaryModelResolver.completeUserPrompt(state, "intake-intent", prompt);

      IntakeIntent intent = parseResponse(response);
      log.info(
          "IntakeIntent: needsTools={}, needsPlanning={}, tools={}, reason={}",
          intent.needsTools(),
          intent.needsPlanning(),
          intent.tools().stream().map(IntakeIntent.ToolHint::name).toList(),
          intent.reason());
      return intent;
    } catch (Exception e) {
      log.warn("IntakeIntent classification failed, using defaults: {}", e.getMessage());
      return IntakeIntent.defaults();
    }
  }

  IntakeIntent parseResponse(String response) throws Exception {
    String json = LlmJsonExtract.parseableJson(response);
    JsonNode root = mapper.readTree(json);
    boolean needsTools = bool(root, "needsTools");
    boolean needsPlanning = bool(root, "needsPlanning", true);
    String reason = root.path("reason").asText("");
    List<IntakeIntent.ToolHint> tools = parseTools(root.get("tools"));
    if (needsTools && tools.isEmpty()) {
      needsPlanning = true;
    }
    IntakeIntent.DispatchPath dispatchPath = parseDispatchPath(root, needsTools, needsPlanning, tools);
    return new IntakeIntent(needsTools, needsPlanning, tools, reason, dispatchPath);
  }

  /**
   * Resolves the dispatch path from the LLM classification response.
   *
   * <p>Design principle: dispatchPath is determined by <b>task complexity</b>,
   * NOT by tool type. MCP tools and Skills are execution resources available
   * during task execution — they do not determine the routing path.
   *
   * <p>Routing logic:
   * <ol>
   *   <li>Explicit LLM suggestion (CONVERSATIONAL / SIMPLE / GRAPH)</li>
   *   <li>!needsTools && !needsPlanning → CONVERSATIONAL</li>
   *   <li>needsTools && !needsPlanning → SIMPLE (single-round tool-assisted)</li>
   *   <li>needsPlanning → GRAPH (full pipeline)</li>
   * </ol>
   */
  private IntakeIntent.DispatchPath parseDispatchPath(
          JsonNode root, boolean needsTools, boolean needsPlanning,
          List<IntakeIntent.ToolHint> tools) {
    // 1. Explicit LLM suggestion takes priority
    JsonNode dpNode = root.get("dispatchPath");
    if (dpNode != null && !dpNode.isNull()) {
      String dp = dpNode.asText("").trim().toUpperCase();
      // Map legacy values: MCP_DIRECT/SKILL_DIRECT → SIMPLE
      if ("MCP_DIRECT".equals(dp) || "SKILL_DIRECT".equals(dp)) {
        return IntakeIntent.DispatchPath.SIMPLE;
      }
      try {
        return IntakeIntent.DispatchPath.valueOf(dp);
      } catch (IllegalArgumentException ignored) {
        // fall through to inference
      }
    }
    // 2. Infer from task complexity (not tool type)
    if (!needsTools && !needsPlanning) {
      return IntakeIntent.DispatchPath.CONVERSATIONAL;
    }
    // 3. Needs tools but no planning → single-round execution
    if (needsTools && !needsPlanning) {
      return IntakeIntent.DispatchPath.SIMPLE;
    }
    // 4. Needs planning → full graph pipeline
    return IntakeIntent.DispatchPath.GRAPH;
  }

  private List<IntakeIntent.ToolHint> parseTools(JsonNode arr) {
    List<IntakeIntent.ToolHint> out = new ArrayList<>();
    if (arr == null || !arr.isArray()) {
      return out;
    }
    for (JsonNode item : arr) {
      if (item.isTextual()) {
        out.add(new IntakeIntent.ToolHint(item.asText(), ""));
        continue;
      }
      String name = item.path("name").asText("").trim();
      if (name.isEmpty()) {
        continue;
      }
      String why = item.path("why").asText("");
      out.add(new IntakeIntent.ToolHint(name, why));
    }
    return out;
  }

  private static boolean bool(JsonNode root, String field) {
    return bool(root, field, false);
  }

  private static boolean bool(JsonNode root, String field, boolean defaultValue) {
    JsonNode n = root.get(field);
    if (n == null || n.isNull()) {
      return defaultValue;
    }
    return n.asBoolean(defaultValue);
  }

  private static String formatMcpToolsSection(List<Map<String, Object>> mcpTools) {
    if (mcpTools == null || mcpTools.isEmpty()) {
      return "";
    }
    StringBuilder sb = new StringBuilder("\n[MCP TOOLS — also available]\n");
    for (Map<String, Object> tool : mcpTools) {
      String name = String.valueOf(tool.getOrDefault("name", "unknown"));
      String desc = String.valueOf(tool.getOrDefault("description", ""));
      sb.append("- ").append(name);
      if (!desc.isBlank() && !"null".equals(desc)) {
        sb.append(": ").append(desc);
      }
      sb.append("\n");
    }
    return sb.toString();
  }
}
