package io.codepilot.core.agent;

import io.codepilot.core.permission.PermissionRule.Action;
import io.codepilot.core.permission.PermissionRuleset;
import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Service;

/**
 * Registry of agent definitions
 * agents are configuration objects loaded from built-in definitions + DB + config.
 *
 * <p>Provides:
 * <ul>
 *   <li>Lookup by name</li>
 *   <li>List visible agents (non-hidden)</li>
 *   <li>Default agent for new sessions</li>
 *   <li>Subagent resolution for spawning</li>
 *   <li>LLM-based agent generation (future)</li>
 * </ul>
 */
@Service
public class AgentRegistry {

  private static final Logger log = LoggerFactory.getLogger(AgentRegistry.class);
  private static final String PROMPT_RESOURCE_PREFIX = "classpath:prompts/agent/";

  private final Map<String, AgentDefinition> agents = new ConcurrentHashMap<>();

  @PostConstruct
  public void init() {
    registerBuiltInAgents();
    log.info("AgentRegistry initialized with {} agents", agents.size());
  }

  public Optional<AgentDefinition> get(String name) {
    return Optional.ofNullable(agents.get(name));
  }

  public AgentDefinition getOrThrow(String name) {
    return get(name).orElseThrow(() ->
        new IllegalArgumentException("Unknown agent: " + name));
  }

  public List<AgentDefinition> list() {
    return agents.values().stream()
        .filter(a -> !a.hidden())
        .sorted(Comparator.comparing(AgentDefinition::name))
        .toList();
  }

  public List<AgentDefinition> listAll() {
    return agents.values().stream()
        .sorted(Comparator.comparing(AgentDefinition::name))
        .toList();
  }

  public List<AgentDefinition> subagents() {
    return agents.values().stream()
        .filter(AgentDefinition::isSubagent)
        .toList();
  }

  public AgentDefinition defaultAgent() {
    return get("build").orElseThrow();
  }

  /** Resolve an agent by mode string from RunRequest, falling back to "build". */
  public AgentDefinition resolve(String mode) {
    if (mode == null || mode.isBlank()) return defaultAgent();
    return get(mode).orElseGet(this::defaultAgent);
  }

  public void register(AgentDefinition def) {
    agents.put(def.name(), def);
  }

  // ── Built-in Agent Definitions ────────────────────────────────────────

  private void registerBuiltInAgents() {
    // ── Build Agent (default, full permissions) ──
    register(AgentDefinition.builder()
        .name("build")
        .description("Default coding agent with full tool permissions for development")
        .mode(AgentDefinition.Mode.PRIMARY)
        .nativeAgent(true)
        .hidden(false)
        .temperature(0.0)
        .topP(1.0)
        .steps(50)
        .permissionRules(PermissionRuleset.builder()
            .allow("*")
            .ask("doom_loop")
            .ask("external_directory", "*")
            .build())
        .promptResource("prompts/agent/build.txt")
        .build());

    // ── Plan Agent (read-only analysis) ──
    register(AgentDefinition.builder()
        .name("plan")
        .description("Read-only agent for code analysis and planning")
        .mode(AgentDefinition.Mode.PRIMARY)
        .nativeAgent(true)
        .hidden(false)
        .temperature(0.2)
        .topP(0.9)
        .steps(30)
        .permissionRules(PermissionRuleset.builder()
            .allow("read")
            .allow("grep")
            .allow("glob")
            .allow("list")
            .allow("memory")
            .allow("question")
            .allow("skill")
            .deny("write")
            .deny("edit")
            .deny("bash")
            .deny("commit")
            .deny("plan_enter")
            .deny("plan_exit")
            .deny("external_directory")
            .build())
        .toolAllowlist(List.of("fs.read", "fs.search", "fs.list", "fs.grep", "fs.outline",
            "code.outline", "code.symbol", "code.usages", "ide.diagnostics",
            "memory", "ask_user", "skill"))
        .promptResource("prompts/agent/plan.txt")
        .build());

    // ── Compose Agent (skill-driven orchestration) ──
    register(AgentDefinition.builder()
        .name("compose")
        .description("Orchestration agent for specs-driven development using skills")
        .mode(AgentDefinition.Mode.PRIMARY)
        .nativeAgent(true)
        .hidden(false)
        .temperature(0.1)
        .topP(0.95)
        .steps(80)
        .permissionRules(PermissionRuleset.builder()
            .allow("skill")
            .allow("question")
            .allow("read")
            .allow("grep")
            .allow("glob")
            .allow("list")
            .allow("memory")
            .allow("task_create")
            .allow("task_update")
            .allow("task_list")
            .ask("write")
            .ask("edit")
            .ask("bash")
            .ask("external_directory", "*")
            .deny("doom_loop")
            .build())
        .toolAllowlist(List.of(
            "fs.read", "fs.search", "fs.list", "fs.grep", "fs.outline",
            "fs.write", "fs.create", "fs.replace", "fs.delete", "fs.move", "fs.applyPatch",
            "shell.exec", "shell.session",
            "code.outline", "code.symbol", "code.usages",
            "ide.openFile", "ide.diagnostics", "ide.applyPatch", "ide.shadowValidate",
            "notepad.write", "notepad.read", "commit",
            "memory", "ask_user", "skill",
            "task_create", "task_update", "task_list"))
        .promptResource("prompts/agent/compose.txt")
        .build());

    // ── Explore Subagent (fast codebase exploration) ──
    register(AgentDefinition.builder()
        .name("explore")
        .description("Fast subagent for codebase exploration and search")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.0)
        .steps(15)
        .permissionRules(PermissionRuleset.builder()
            .allow("read")
            .allow("grep")
            .allow("glob")
            .allow("list")
            .deny("write")
            .deny("edit")
            .deny("bash")
            .deny("commit")
            .build())
        .toolAllowlist(List.of("fs.read", "fs.search", "fs.list", "fs.grep", "fs.outline",
            "code.outline", "code.symbol", "code.usages", "ide.diagnostics"))
        .promptResource("prompts/agent/explore.txt")
        .build());

    // ── General Subagent (parallel work) ──
    register(AgentDefinition.builder()
        .name("general")
        .description("General-purpose subagent for parallel task execution")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.0)
        .steps(30)
        .permissionRules(PermissionRuleset.builder()
            .allow("*")
            .ask("bash")
            .ask("external_directory", "*")
            .build())
        .promptResource("prompts/agent/build.txt") // Reuse build prompt
        .build());

    // ── Hidden: Title Generator ──
    register(AgentDefinition.builder()
        .name("title")
        .description("Generates concise titles for sessions")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.0)
        .steps(1)
        .permissionRules(PermissionRuleset.builder().deny("*").build())
        .promptResource("prompts/agent/title.txt")
        .build());

    // ── Hidden: Summary Generator ──
    register(AgentDefinition.builder()
        .name("summary")
        .description("Generates session summaries")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.0)
        .steps(1)
        .permissionRules(PermissionRuleset.builder().deny("*").build())
        .promptResource("prompts/agent/summary.txt")
        .build());

    // ── Hidden: Compaction Subagent ──
    register(AgentDefinition.builder()
        .name("compaction")
        .description("Compacts conversation history into summaries")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.0)
        .steps(1)
        .permissionRules(PermissionRuleset.builder().deny("*").build())
        .promptResource("prompts/agent/compaction.txt")
        .build());

    // ── Hidden: Checkpoint Writer ──
    register(AgentDefinition.builder()
        .name("checkpoint-writer")
        .description("Writes structured checkpoints for session state")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.0)
        .steps(1)
        .permissionRules(PermissionRuleset.builder()
            .allow("read")
            .allow("memory")
            .deny("*")
            .build())
        .promptResource("prompts/agent/checkpoint-writer.txt")
        .build());

    // ── Hidden: Dream Subagent ──
    register(AgentDefinition.builder()
        .name("dream")
        .description("Analyzes recent sessions and extracts persistent knowledge into project memory")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.1)
        .steps(15)
        .permissionRules(PermissionRuleset.builder()
            .allow("read")
            .allow("write")
            .allow("edit")
            .allow("glob")
            .allow("grep")
            .allow("list")
            .allow("memory")
            .allow("bash")
            .deny("external_directory")
            .build())
        .toolAllowlist(List.of(
            "fs.read", "fs.write", "fs.search", "fs.list", "fs.grep", "fs.outline",
            "fs.create", "fs.replace", "fs.delete", "fs.move", "fs.applyPatch",
            "memory", "shell.exec", "shell.session", "commit", "notepad.write", "notepad.read"))
        .promptResource("prompts/agent/dream.txt")
        .build());

    // ── Hidden: Distill Subagent ──
    register(AgentDefinition.builder()
        .name("distill")
        .description("Discovers repeated workflows and packages them into reusable skills")
        .mode(AgentDefinition.Mode.SUBAGENT)
        .nativeAgent(true)
        .hidden(true)
        .temperature(0.1)
        .steps(15)
        .permissionRules(PermissionRuleset.builder()
            .allow("read")
            .allow("write")
            .allow("edit")
            .allow("glob")
            .allow("grep")
            .allow("list")
            .allow("memory")
            .allow("bash")
            .deny("external_directory")
            .build())
        .toolAllowlist(List.of(
            "fs.read", "fs.write", "fs.search", "fs.list", "fs.grep", "fs.outline",
            "fs.create", "fs.replace", "fs.delete", "fs.move", "fs.applyPatch",
            "memory", "shell.exec", "shell.session", "commit", "notepad.write", "notepad.read"))
        .promptResource("prompts/agent/distill.txt")
        .build());
  }
}
