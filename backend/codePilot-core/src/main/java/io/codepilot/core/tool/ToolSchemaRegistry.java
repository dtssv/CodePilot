package io.codepilot.core.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.annotation.PostConstruct;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Static catalogue of built-in tool definitions.
 *
 * <p>Each entry follows the shape required by docs/04-Prompt模板.md §9.5: {@code name /
 * description / parameters / executor / risk}. Plugins are expected to advertise the same names so
 * the model can call them.
 */
@Component
public class ToolSchemaRegistry {

  private final ObjectMapper mapper;
  private final Map<String, ObjectNode> tools = new LinkedHashMap<>();

  public ToolSchemaRegistry(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  @PostConstruct
  void register() {
    add(
        "fs.read",
        "Read a file (optional line range). Returns UTF-8 text up to maxBytes.",
        "client",
        "low",
        params(
            required("path"),
            optionalIntRange("range.startLine"),
            optionalIntRange("range.endLine"),
            optionalInt("maxBytes", 262_144)));

    add(
        "fs.list",
        "List directory entries (project-relative). Returns names + types.",
        "client",
        "low",
        params(required("path"), optionalBoolean("recursive", false)));

    add(
        "fs.search",
        "Project-wide find-in-path; returns hits with path:lineRange and short snippets.",
        "client",
        "low",
        params(required("query"), optionalString("glob"), optionalBoolean("regex", false)));

    add(
        "fs.outline",
        "PSI outline (classes / methods / fields) of a single file.",
        "client",
        "low",
        params(required("path")));

    add(
        "fs.create",
        "Create a new file (parent dirs auto-created).",
        "client",
        "medium",
        params(
            required("path"),
            optionalString("content", ""),
            optionalBoolean("overwrite", false)));

    add(
        "fs.write",
        "Overwrite an existing file with `content` (use sparingly; prefer fs.replace).",
        "client",
        "medium",
        params(required("path"), required("content"), optionalBoolean("createIfMissing", true)));

    add(
        "fs.replace",
        "Local text/regex replace; pass `range` to bound the edit; set `expectMatches` to assert.",
        "client",
        "medium",
        params(
            required("path"),
            required("search"),
            required("replace"),
            optionalBoolean("regex", false),
            optionalBoolean("ignoreCase", false),
            optionalIntRange("range.startLine"),
            optionalIntRange("range.endLine"),
            optionalInt("expectMatches", null)));

    add(
        "fs.delete",
        "Move file/directory to OS trash (recoverable).",
        "client",
        "high",
        params(required("path"), optionalBoolean("recursive", false)));

    add(
        "fs.move",
        "Move/rename a file/directory; integrates with refactor for usage updates.",
        "client",
        "high",
        params(required("from"), required("to"), optionalBoolean("overwrite", false)));

    add(
        "shell.exec",
        "Run a single non-interactive command. OS-adapted (powershell on Windows, bash elsewhere).",
        "client",
        "high",
        params(
            required("command"),
            optionalString("cwd"),
            optionalInt("timeoutMs", 60_000),
            optionalEnum("osHint", "windows", "macos", "linux"),
            optionalObject("env")));

    add(
        "plan.show",
        "Push the latest Plan / PlanDelta to the IDE Plan panel; never executes a side-effect.",
        "client",
        "low",
        params(optionalObject("plan"), optionalObject("delta")));

    add(
        "rag.search",
        "Server-side RAG retrieval over the session's pgvector index; returns top-k hits.",
        "server",
        "low",
        params(required("query"), optionalInt("topK", 8)));
  }

  /** Returns the JSON Schema (as a string) restricted to {@code allowed} tool names, or full set. */
  public String renderSchema(List<String> allowed) {
    ArrayNode arr = mapper.createArrayNode();
    if (allowed == null || allowed.isEmpty()) {
      tools.values().forEach(arr::add);
    } else {
      for (String name : allowed) {
        ObjectNode node = tools.get(name);
        if (node != null) arr.add(node);
      }
    }
    ObjectNode root = mapper.createObjectNode();
    root.set("tools", arr);
    return root.toString();
  }

  /** Returns the immutable set of registered tool names. */
  public List<String> names() {
    return List.copyOf(tools.keySet());
  }

  /** One-line-per-tool catalog for intake intent classification prompts. */
  public String renderCatalogBrief() {
    StringBuilder sb = new StringBuilder("[TOOL CATALOG — use exact names in tools[]]\n");
    for (ObjectNode node : tools.values()) {
      sb.append("- ").append(node.path("name").asText());
      sb.append(": ").append(node.path("description").asText()).append("\n");
    }
    return sb.toString();
  }

  /**
   * Dynamically register MCP tools for a session. Called when the plugin sends {@code userMcps[]}
   * in the request. These tools are added to the session-level schema and evicted at session end.
   *
   * @param mcpTools list of MCP tool definitions (name, description, parameters as JSON Schema)
   */
  public void registerSessionMcpTools(List<Map<String, Object>> mcpTools) {
    if (mcpTools == null) return;
    for (Map<String, Object> tool : mcpTools) {
      String name = (String) tool.get("name");
      String desc = (String) tool.getOrDefault("description", "");
      if (name == null || tools.containsKey(name)) continue;
      ObjectNode node = mapper.createObjectNode();
      node.put("name", name);
      node.put("description", desc);
      node.set("parameters", mapper.valueToTree(tool.getOrDefault("parameters", Collections.emptyMap())));
      node.put("executor", "client");
      node.put("risk", (String) tool.getOrDefault("risk", "medium"));
      tools.put(name, node);
    }
  }

  /** Remove all dynamically registered MCP tools (keyed by prefix). */
  public void unregisterMcpTools(String prefix) {
    tools.keySet().removeIf(k -> k.startsWith(prefix));
  }

  private void add(String name, String desc, String executor, String risk, ObjectNode params) {
    ObjectNode node = mapper.createObjectNode();
    node.put("name", name);
    node.put("description", desc);
    node.set("parameters", params);
    node.put("executor", executor);
    node.put("risk", risk);
    tools.put(name, node);
  }

  // -------- tiny Schema builders to keep the registration table readable -------- //

  private ObjectNode params(ObjectNode... fields) {
    ObjectNode obj = mapper.createObjectNode();
    obj.put("type", "object");
    ObjectNode properties = mapper.createObjectNode();
    ArrayNode required = mapper.createArrayNode();
    for (ObjectNode f : fields) {
      ObjectNode prop = (ObjectNode) f.get("__prop");
      String n = f.get("__name").asText();
      properties.set(n, prop);
      if (f.path("__required").asBoolean(false)) required.add(n);
    }
    obj.set("properties", properties);
    if (!required.isEmpty()) obj.set("required", required);
    return obj;
  }

  private ObjectNode field(String name, ObjectNode prop, boolean required) {
    ObjectNode node = mapper.createObjectNode();
    node.put("__name", name);
    node.set("__prop", prop);
    node.put("__required", required);
    return node;
  }

  private ObjectNode required(String name) {
    return field(name, mapper.createObjectNode().put("type", "string"), true);
  }

  private ObjectNode optionalString(String name) {
    return field(name, mapper.createObjectNode().put("type", "string"), false);
  }

  private ObjectNode optionalString(String name, String defVal) {
    ObjectNode prop = mapper.createObjectNode().put("type", "string");
    if (defVal != null) prop.put("default", defVal);
    return field(name, prop, false);
  }

  private ObjectNode optionalBoolean(String name, boolean defVal) {
    return field(
        name,
        mapper.createObjectNode().put("type", "boolean").put("default", defVal),
        false);
  }

  private ObjectNode optionalInt(String name, Integer defVal) {
    ObjectNode prop = mapper.createObjectNode().put("type", "integer");
    if (defVal != null) prop.put("default", defVal);
    return field(name, prop, false);
  }

  private ObjectNode optionalIntRange(String pathLabel) {
    return field(pathLabel, mapper.createObjectNode().put("type", "integer"), false);
  }

  private ObjectNode optionalObject(String name) {
    return field(name, mapper.createObjectNode().put("type", "object"), false);
  }

  private ObjectNode optionalEnum(String name, String... values) {
    ObjectNode prop = mapper.createObjectNode();
    prop.put("type", "string");
    ArrayNode enumArr = mapper.createArrayNode();
    for (String v : values) enumArr.add(v);
    prop.set("enum", enumArr);
    return field(name, prop, false);
  }
}