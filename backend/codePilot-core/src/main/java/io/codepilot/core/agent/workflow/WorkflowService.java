package io.codepilot.core.agent.workflow;

import io.codepilot.core.agent.AgentLoop;
import io.codepilot.core.agent.AgentLoopFactory;
import io.codepilot.core.session.Message;
import io.codepilot.core.session.SessionState;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.HostAccess;
import org.graalvm.polyglot.PolyglotException;
import org.graalvm.polyglot.Value;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Dynamic Workflow — executes an LLM-generated JavaScript orchestration script inside a sandboxed
 * GraalVM polyglot context.
 *
 * <p>The script orchestrates subagents through a small, explicit host API exposed as the global
 * {@code cp} object:
 *
 * <ul>
 *   <li>{@code cp.agent(name, prompt)} — run a subagent to completion and return its result text.
 *   <li>{@code cp.parallel([{agent, prompt}, ...])} — run subagents concurrently, return results
 *       array.
 *   <li>{@code cp.pipeline([{agent, prompt}, ...])} — run subagents sequentially, feeding each step
 *       the previous step's output; return the final output.
 *   <li>{@code cp.workflow(steps)} — alias for {@code pipeline} returning the joined transcript.
 *   <li>{@code cp.log(msg)} — emit a diagnostic log line.
 * </ul>
 *
 * <p>Sandboxing: the context disables host class lookup, native access, IO, threads, and process
 * creation; only the explicitly exported {@code cp} methods are reachable. Each {@code agent()}
 * result is memoized in {@code workflow_steps} so a crashed workflow can be resumed without
 * re-running completed steps.
 */
@Service
public class WorkflowService {

  private static final Logger log = LoggerFactory.getLogger(WorkflowService.class);

  private final AgentLoopFactory loopFactory;
  private final JdbcTemplate jdbc;
  private final long scriptTimeoutMs;

  public WorkflowService(
      AgentLoopFactory loopFactory,
      JdbcTemplate jdbc,
      @org.springframework.beans.factory.annotation.Value(
              "${codepilot.workflow.script-timeout-ms:600000}")
          long scriptTimeoutMs) {
    this.loopFactory = loopFactory;
    this.jdbc = jdbc;
    this.scriptTimeoutMs = scriptTimeoutMs;
  }

  /** Result of a workflow run. */
  public record WorkflowResult(String workflowId, String status, String result, String error) {}

  /** Run a workflow script. Persists the run and each agent step for crash recovery. */
  public WorkflowResult run(String userId, String sessionId, String goal, String script) {
    String workflowId = "wf_" + UUID.randomUUID().toString().substring(0, 12);
    persistRunStart(workflowId, sessionId, userId, goal, script);

    WorkflowBridge bridge = new WorkflowBridge(workflowId, userId);
    try (Context ctx = buildSandbox()) {
      ctx.getBindings("js").putMember("cp", bridge);
      Value result = ctx.eval("js", script);
      String out = result != null && !result.isNull() ? result.toString() : "";
      persistRunEnd(workflowId, "COMPLETED", out, null);
      return new WorkflowResult(workflowId, "COMPLETED", out, null);
    } catch (PolyglotException e) {
      String msg =
          e.isGuestException()
              ? "Script error: " + e.getMessage()
              : "Sandbox error: " + e.getMessage();
      log.warn("Workflow {} failed: {}", workflowId, msg);
      persistRunEnd(workflowId, "FAILED", null, msg);
      return new WorkflowResult(workflowId, "FAILED", null, msg);
    } catch (Exception e) {
      log.error("Workflow {} failed", workflowId, e);
      persistRunEnd(workflowId, "FAILED", null, e.getMessage());
      return new WorkflowResult(workflowId, "FAILED", null, e.getMessage());
    }
  }

  private Context buildSandbox() {
    return Context.newBuilder("js")
        .allowHostAccess(HostAccess.EXPLICIT) // only @HostAccess.Export methods are reachable
        .allowHostClassLookup(className -> false)
        .allowCreateThread(false)
        .allowCreateProcess(false)
        .allowNativeAccess(false)
        .allowIO(org.graalvm.polyglot.io.IOAccess.NONE)
        .allowEnvironmentAccess(org.graalvm.polyglot.EnvironmentAccess.NONE)
        .option("js.ecmascript-version", "2022")
        .build();
  }

  // ── Host bridge exposed to the sandbox as `cp` ──────────────────────────

  public class WorkflowBridge {
    private final String workflowId;
    private final String userId;

    WorkflowBridge(String workflowId, String userId) {
      this.workflowId = workflowId;
      this.userId = userId;
    }

    @HostAccess.Export
    public String agent(String agentName, String prompt) {
      String stepKey = stepKey(agentName, prompt);
      String memo = loadStep(workflowId, stepKey);
      if (memo != null) {
        log.debug("Workflow {} step {} resumed from memo", workflowId, stepKey);
        return memo;
      }
      String output = runAgent(agentName, prompt);
      saveStep(workflowId, stepKey, agentName, prompt, output);
      return output;
    }

    @HostAccess.Export
    public String log(String message) {
      log.info("[workflow {}] {}", workflowId, message);
      return "";
    }

    @HostAccess.Export
    public Object parallel(Value tasks) {
      List<Step> steps = readSteps(tasks);
      List<CompletableFuture<String>> futures = new ArrayList<>();
      for (Step s : steps) {
        futures.add(CompletableFuture.supplyAsync(() -> agent(s.agent(), s.prompt())));
      }
      String[] results = new String[futures.size()];
      for (int i = 0; i < futures.size(); i++) {
        try {
          results[i] = futures.get(i).get();
        } catch (Exception e) {
          results[i] = "[error: " + e.getMessage() + "]";
        }
      }
      return results;
    }

    @HostAccess.Export
    public String pipeline(Value tasks) {
      List<Step> steps = readSteps(tasks);
      String carried = "";
      for (Step s : steps) {
        String prompt =
            carried.isBlank() ? s.prompt() : s.prompt() + "\n\n## Previous step output\n" + carried;
        carried = agent(s.agent(), prompt);
      }
      return carried;
    }

    @HostAccess.Export
    public String workflow(Value tasks) {
      List<Step> steps = readSteps(tasks);
      StringBuilder transcript = new StringBuilder();
      String carried = "";
      for (Step s : steps) {
        String prompt =
            carried.isBlank() ? s.prompt() : s.prompt() + "\n\n## Previous step output\n" + carried;
        carried = agent(s.agent(), prompt);
        transcript.append("### ").append(s.agent()).append("\n").append(carried).append("\n\n");
      }
      return transcript.toString();
    }

    private String runAgent(String agentName, String prompt) {
      String childId = workflowId + "__" + UUID.randomUUID().toString().substring(0, 8);
      SessionState child =
          new SessionState(childId, userId != null ? userId : "workflow", "default");
      child.setCurrentAgent(agentName != null && !agentName.isBlank() ? agentName : "general");
      child.setInput(prompt);
      child.setGoalCondition("Complete the task and return a concise result.");
      child.setMaxTurns(20);
      child.addUserMessage(prompt);

      AgentLoop loop = loopFactory.create(child, child.getCurrentAgent());
      try {
        loop.run().blockLast(java.time.Duration.ofMillis(scriptTimeoutMs));
      } catch (Exception e) {
        log.warn("Workflow {} agent {} failed: {}", workflowId, agentName, e.getMessage());
      }
      return lastAssistantText(child);
    }
  }

  private record Step(String agent, String prompt) {}

  private List<Step> readSteps(Value tasks) {
    List<Step> steps = new ArrayList<>();
    if (tasks == null || !tasks.hasArrayElements()) return steps;
    long n = tasks.getArraySize();
    for (long i = 0; i < n; i++) {
      Value el = tasks.getArrayElement(i);
      String agent = el.hasMember("agent") ? el.getMember("agent").asString() : "general";
      String prompt = el.hasMember("prompt") ? el.getMember("prompt").asString() : "";
      steps.add(new Step(agent, prompt));
    }
    return steps;
  }

  private static String lastAssistantText(SessionState session) {
    var msgs = session.getMessages();
    for (int i = msgs.size() - 1; i >= 0; i--) {
      Message m = msgs.get(i);
      if (m.role() == Message.Role.ASSISTANT && m.content() != null && !m.content().isBlank()) {
        return m.content();
      }
    }
    return "";
  }

  private static String stepKey(String agentName, String prompt) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      byte[] digest = md.digest((agentName + "\u0000" + prompt).getBytes(StandardCharsets.UTF_8));
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < 8; i++) sb.append(String.format("%02x", digest[i]));
      return (agentName == null ? "general" : agentName) + ":" + sb;
    } catch (Exception e) {
      return (agentName == null ? "general" : agentName)
          + ":"
          + Integer.toHexString(prompt.hashCode());
    }
  }

  // ── Persistence (crash recovery) ────────────────────────────────────────

  private void persistRunStart(
      String workflowId, String sessionId, String userId, String goal, String script) {
    try {
      jdbc.update(
          "INSERT INTO workflow_runs (id, session_id, user_id, goal, script, status) VALUES"
              + " (?,?,?,?,?, 'RUNNING')",
          workflowId,
          sessionId,
          userId,
          goal,
          script);
    } catch (Exception e) {
      log.warn("Failed to persist workflow start {}", workflowId, e);
    }
  }

  private void persistRunEnd(String workflowId, String status, String result, String error) {
    try {
      jdbc.update(
          "UPDATE workflow_runs SET status=?, result=?, error=? WHERE id=?",
          status,
          result,
          error,
          workflowId);
    } catch (Exception e) {
      log.warn("Failed to persist workflow end {}", workflowId, e);
    }
  }

  private String loadStep(String workflowId, String stepKey) {
    try {
      var rows =
          jdbc.queryForList(
              "SELECT output FROM workflow_steps WHERE workflow_id=? AND step_key=? AND"
                  + " status='DONE'",
              workflowId,
              stepKey);
      return rows.isEmpty() ? null : (String) rows.get(0).get("output");
    } catch (Exception e) {
      return null;
    }
  }

  private void saveStep(
      String workflowId, String stepKey, String agentName, String input, String output) {
    try {
      jdbc.update(
          "INSERT INTO workflow_steps (id, workflow_id, step_key, agent_name, input, output,"
              + " status) VALUES (?,?,?,?,?,?, 'DONE') ON DUPLICATE KEY UPDATE"
              + " output=VALUES(output), status='DONE'",
          UUID.randomUUID().toString(),
          workflowId,
          stepKey,
          agentName,
          input,
          output);
    } catch (Exception e) {
      log.warn("Failed to persist workflow step {}/{}", workflowId, stepKey, e);
    }
  }
}
