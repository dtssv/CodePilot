package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.sse.SseEvents;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Executes client-side tool calls emitted from generate (shell.exec, fs.read, …). */
public final class GraphDirectToolExecutor {

  private static final Logger log = LoggerFactory.getLogger(GraphDirectToolExecutor.class);

  private static final Set<String> DIRECT_TOOLS =
      Set.of("shell.exec", "fs.read", "fs.list", "fs.grep", "code.outline", "code.symbol", "code.usages");

  private GraphDirectToolExecutor() {}

  public static boolean containsDirectToolCalls(JsonNode root) {
    if (root == null) {
      return false;
    }
    JsonNode arr = root.get("toolCalls");
    if (arr == null || !arr.isArray()) {
      JsonNode single = root.get("toolCall");
      if (single != null && !single.isNull() && single.isObject()) {
        return isDirectTool(resolveToolName(single));
      }
      return false;
    }
    for (JsonNode tc : arr) {
      if (isDirectTool(resolveToolName(tc))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Runs direct tool calls, merges results into {@code gatheredInfo}, emits TOOL_CALL SSE.
   *
   * @return true if at least one tool was executed
   */
  @SuppressWarnings("unchecked")
  public static boolean executeFromJson(
      OverAllState state, JsonNode root, ObjectMapper mapper, Map<String, Object> updates) {
    List<JsonNode> allCalls = collectDirectToolCalls(root);
    List<JsonNode> calls = filterDuplicateApproaches(state, filterDirectToolCalls(state, allCalls));
    if (calls.isEmpty()) {
      if (!allCalls.isEmpty()) {
        updates.put("approachRepeatBlocked", true);
        @SuppressWarnings("unchecked")
        Map<String, Object> gathered =
            new LinkedHashMap<>(
                (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of()));
        if (ProjectMetaHelper.tryAbsorbRootListing(state, gathered, updates)) {
          PhaseOutcomeHelper.recordGatheredOutcome(state, gathered, updates);
          updates.put("directToolsExecuted", List.of(Map.of("name", "fs.list", "ok", true, "source", "projectMeta")));
          int rounds = (int) state.value("directToolRound").orElse(0) + 1;
          updates.put("directToolRound", rounds);
          return true;
        }
      }
      return false;
    }

    String sessionId = (String) state.value("sessionId").orElse("");
    String phaseId = (String) state.value("phaseCursor").orElse("");
    Map<String, Object> gathered =
        new LinkedHashMap<>((Map<String, Object>) state.value("gatheredInfo").orElse(Map.of()));
    List<Map<String, Object>> executed = new ArrayList<>();

    for (JsonNode tc : calls) {
      String name = resolveToolName(tc);
      if (!isDirectTool(name)) {
        continue;
      }
      String toolCallId = tc.has("id") ? tc.path("id").asText() : UUID.randomUUID().toString();
      Map<String, Object> args =
          tc.has("args")
              ? mapper.convertValue(tc.get("args"), Map.class)
              : Map.of();
      if ("shell.exec".equals(name)) {
        String userInput = (String) state.value("input").orElse("");
        String projectMeta = (String) state.value("projectMeta").orElse("");
        String command = String.valueOf(args.getOrDefault("command", ""));
        String purpose = args.get("purpose") != null ? String.valueOf(args.get("purpose")) : null;
        var block =
            ShellCommandGate.blockReason(
                command, projectMeta, userInput, gathered, PhaseGoalHelper.inferStepKind(state), purpose);
        if (block.isEmpty()) {
          block = SessionExecutionFacts.staleProbeBlockReason(command, state);
        }
        if (block.isPresent()) {
          log.warn("GraphDirectToolExecutor: blocked shell: {}", block.get());
          String reqId = "direct-skip-" + toolCallId;
          gathered.put(
              reqId,
              Map.of(
                  "kind",
                  "shell.exec",
                  "id",
                  reqId,
                  "ok",
                  false,
                  "errorMessage",
                  block.get()));
          continue;
        }
      }
      Map<String, Object> batchArgs =
          Map.of("id", toolCallId, "name", name, "args", args);

      var pending = ToolResultBus.registerFuture(sessionId, toolCallId);
      GraphExecutionLog.toolCallEmit(state, toolCallId, name, batchArgs);
      GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, batchArgs);

      try {
        ToolResultEvent result =
            GraphToolWaitHelper.await(pending, state, "执行工具: " + name, Duration.ofSeconds(180));
        String reqId = "direct-" + toolCallId;
        Map<String, Object> entry = new HashMap<>();
        entry.put("kind", name);
        entry.put("id", reqId);
        // Preserve the LLM-declared purpose for shell.exec (compile / run / probe / configure / other)
        if ("shell.exec".equals(name)) {
          Object purpose = args.get("purpose");
          if (purpose != null && !purpose.toString().isBlank()) {
            entry.put("purpose", purpose.toString());
          }
        }
        boolean toolOk = toolSucceeded(name, result);
        entry.put("ok", toolOk);
        if (toolOk && result != null && result.result() != null) {
          entry.put("result", result.result());
        } else {
          Object errBody = result != null ? result.result() : null;
          String errMsg =
              result != null && result.errorMessage() != null
                  ? result.errorMessage()
                  : shellErrorFromResult(errBody);
          entry.put("errorMessage", errMsg);
          if (errBody != null) {
            entry.put("result", errBody);
          }
        }
        gathered.put(reqId, entry);
        executed.add(Map.of("toolCallId", toolCallId, "name", name, "ok", toolOk));
        log.info("GraphDirectToolExecutor: {} ok={}", name, toolOk);
      } catch (Exception e) {
        log.warn("GraphDirectToolExecutor: {} failed: {}", name, e.getMessage());
        String reqId = "direct-" + toolCallId;
        gathered.put(reqId, Map.of("kind", name, "id", reqId, "error", e.getMessage()));
        executed.add(Map.of("toolCallId", toolCallId, "name", name, "ok", false));
      }
    }

    if (executed.isEmpty()) {
      return false;
    }
    PhaseOutcomeHelper.recordGatheredOutcome(state, gathered, updates);
    ToolApproachTracker.recordFromDirectCalls(state, calls, gathered, updates);
    updates.put("directToolsExecuted", executed);
    int rounds = (int) state.value("directToolRound").orElse(0) + 1;
    updates.put("directToolRound", rounds);
    return true;
  }

  private static List<JsonNode> filterDuplicateApproaches(OverAllState state, List<JsonNode> calls) {
    List<JsonNode> out = new ArrayList<>();
    for (JsonNode tc : calls) {
      String fp =
          ToolApproachTracker.fingerprintFromJson(resolveToolName(tc), tc.get("args"));
      if (!ToolApproachTracker.alreadyAttempted(state, fp)) {
        out.add(tc);
      } else {
        log.warn("GraphDirectToolExecutor: skipping duplicate approach {}", fp);
      }
    }
    return out;
  }

  private static List<JsonNode> collectDirectToolCalls(JsonNode root) {
    List<JsonNode> out = new ArrayList<>();
    if (root == null) {
      return out;
    }
    JsonNode arr = root.get("toolCalls");
    if (arr != null && arr.isArray()) {
      for (JsonNode tc : arr) {
        if (isDirectTool(resolveToolName(tc))) {
          out.add(tc);
        }
      }
    }
    JsonNode single = root.get("toolCall");
    if (single != null && !single.isNull() && single.isObject()) {
      if (isDirectTool(resolveToolName(single))) {
        out.add(single);
      }
    }
    return out;
  }

  private static boolean isDirectTool(String name) {
    return name != null && DIRECT_TOOLS.contains(name);
  }

  /** At most one shell.exec per generate pass; keep non-shell tools. */
  private static List<JsonNode> filterDirectToolCalls(OverAllState state, List<JsonNode> calls) {
    List<JsonNode> out = new ArrayList<>();
    boolean shellScheduled = false;
    for (JsonNode tc : calls) {
      String name = resolveToolName(tc);
      if ("shell.exec".equals(name)) {
        if (shellScheduled) {
          continue;
        }
        shellScheduled = true;
      }
      out.add(tc);
    }
    return out;
  }

  /** LLM often uses infoRequests shape ({@code kind}) — accept {@code name} or {@code kind}. */
  private static String resolveToolName(JsonNode tc) {
    if (tc == null || tc.isNull()) {
      return "";
    }
    String name = tc.path("name").asText("").trim();
    if (!name.isEmpty()) {
      return name;
    }
    return tc.path("kind").asText("").trim();
  }

  private static boolean toolSucceeded(String toolName, ToolResultEvent result) {
    if (result == null) {
      return false;
    }
    if ("fs.list".equals(toolName)) {
      if (!result.ok() || !(result.result() instanceof Map<?, ?> m)) {
        return false;
      }
      Object entries = m.get("entries");
      // Empty directory is a valid result — the list call succeeded,
      // the directory simply has no contents. Do NOT treat this as failure.
      return entries instanceof List<?>;
    }
    if (!"shell.exec".equals(toolName)) {
      return result.ok();
    }
    if (!(result.result() instanceof Map<?, ?> m)) {
      return false;
    }
    Object exit = m.get("exitCode");
    int code = exit instanceof Number n ? n.intValue() : -1;
    return code == 0 && !Boolean.TRUE.equals(m.get("timedOut"));
  }

  private static String shellErrorFromResult(Object result) {
    if (result instanceof Map<?, ?> m) {
      Object stderr = m.get("stderr");
      if (stderr != null && !stderr.toString().isBlank()) {
        return stderr.toString().trim();
      }
      Object exit = m.get("exitCode");
      if (exit instanceof Number n && n.intValue() != 0) {
        return "exit code " + n.intValue();
      }
    }
    return "Tool execution failed or timed out";
  }
}
