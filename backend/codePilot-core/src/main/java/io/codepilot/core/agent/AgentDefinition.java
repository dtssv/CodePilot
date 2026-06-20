package io.codepilot.core.agent;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import io.codepilot.core.permission.PermissionRuleset;
import java.util.List;
import java.util.Map;

/**
 * Configuration-driven agent definition
 *
 * <p>Agents are not hardcoded classes - they are configuration objects that define
 * behavior: what tools they can use, what permissions they have, what system
 * prompt they use, and what model/temperature overrides apply.
 *
 * <p>Built-in agents:
 * <ul>
 *   <li><b>build</b> - Default. Full tool permissions for development</li>
 *   <li><b>plan</b> - Read-only analysis mode for code exploration</li>
 *   <li><b>compose</b> - Orchestration mode for specs-driven workflows</li>
 *   <li><b>explore</b> - Fast subagent for codebase exploration</li>
 *   <li><b>general</b> - General-purpose subagent for parallel work</li>
 *   <li><b>title/summary/compaction/checkpoint-writer/dream/distill</b> - Hidden subagents</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AgentDefinition(
    @JsonProperty("name") String name,
    @JsonProperty("description") String description,
    @JsonProperty("mode") Mode mode,
    @JsonProperty("native") boolean nativeAgent,
    @JsonProperty("hidden") boolean hidden,
    @JsonProperty("topP") Double topP,
    @JsonProperty("temperature") Double temperature,
    @JsonProperty("color") String color,
    @JsonProperty("permissionRules") PermissionRuleset permissionRules,
    @JsonProperty("modelOverride") ModelOverride modelOverride,
    @JsonProperty("modelRef") String modelRef,
    @JsonProperty("variant") String variant,
    @JsonProperty("prompt") String prompt,
    @JsonProperty("promptResource") String promptResource,
    @JsonProperty("options") Map<String, Object> options,
    @JsonProperty("steps") Integer steps,
    @JsonProperty("toolAllowlist") List<String> toolAllowlist,
    @JsonProperty("promptTemplate") String promptTemplate,
    @JsonProperty("toolMode") ToolMode toolMode,
    @JsonProperty("maxConcurrentSubagents") Integer maxConcurrentSubagents) {

  public enum Mode {
    @JsonProperty("primary") PRIMARY,
    @JsonProperty("subagent") SUBAGENT,
    @JsonProperty("all") ALL
  }

  /** How tools are selected for this agent. */
  public enum ToolMode {
    ALL, ALLOWLIST, READONLY
  }

  public record ModelOverride(
      @JsonProperty("modelId") String modelId,
      @JsonProperty("providerId") String providerId) {}

  /** Whether this agent can be selected as the primary agent. */
  public boolean isPrimary() { return mode == Mode.PRIMARY || mode == Mode.ALL; }

  /** Whether this agent can be spawned as a subagent. */
  public boolean isSubagent() { return mode == Mode.SUBAGENT || mode == Mode.ALL; }

  /** Max turns override for this agent. */
  public int maxSteps() { return steps != null && steps > 0 ? steps : 50; }

  /** Max concurrent subagents, default 3 for compose agent. */
  public int concurrencyLimit() { return maxConcurrentSubagents != null && maxConcurrentSubagents > 0 ? maxConcurrentSubagents : 3; }

  public static Builder builder() { return new Builder(); }

  public static class Builder {
    private String name;
    private String description;
    private Mode mode = Mode.ALL;
    private boolean nativeAgent = false;
    private boolean hidden = false;
    private Double topP;
    private Double temperature;
    private String color;
    private PermissionRuleset permissionRules = new PermissionRuleset();
    private ModelOverride modelOverride;
    private String modelRef;
    private String variant;
    private String prompt;
    private String promptResource;
    private Map<String, Object> options = Map.of();
    private Integer steps;
    private List<String> toolAllowlist;
    private String promptTemplate;
    private ToolMode toolMode;
    private Integer maxConcurrentSubagents;

    public Builder name(String name) { this.name = name; return this; }
    public Builder description(String description) { this.description = description; return this; }
    public Builder mode(Mode mode) { this.mode = mode; return this; }
    public Builder nativeAgent(boolean nativeAgent) { this.nativeAgent = nativeAgent; return this; }
    public Builder hidden(boolean hidden) { this.hidden = hidden; return this; }
    public Builder topP(Double topP) { this.topP = topP; return this; }
    public Builder temperature(Double temperature) { this.temperature = temperature; return this; }
    public Builder color(String color) { this.color = color; return this; }
    public Builder permissionRules(PermissionRuleset rules) { this.permissionRules = rules; return this; }
    public Builder modelOverride(ModelOverride modelOverride) { this.modelOverride = modelOverride; return this; }
    public Builder modelRef(String modelRef) { this.modelRef = modelRef; return this; }
    public Builder variant(String variant) { this.variant = variant; return this; }
    public Builder prompt(String prompt) { this.prompt = prompt; return this; }
    public Builder promptResource(String promptResource) { this.promptResource = promptResource; return this; }
    public Builder options(Map<String, Object> options) { this.options = options; return this; }
    public Builder steps(Integer steps) { this.steps = steps; return this; }
    public Builder toolAllowlist(List<String> toolAllowlist) { this.toolAllowlist = toolAllowlist; return this; }
    public Builder promptTemplate(String promptTemplate) { this.promptTemplate = promptTemplate; return this; }
    public Builder toolMode(ToolMode toolMode) { this.toolMode = toolMode; return this; }
    public Builder maxConcurrentSubagents(Integer maxConcurrentSubagents) { this.maxConcurrentSubagents = maxConcurrentSubagents; return this; }

    public AgentDefinition build() {
      return new AgentDefinition(name, description, mode, nativeAgent, hidden,
          topP, temperature, color, permissionRules, modelOverride, modelRef, variant,
          prompt, promptResource, options, steps, toolAllowlist, promptTemplate, toolMode, maxConcurrentSubagents);
    }
  }
}