package io.codepilot.core.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.agent.goal.GoalJudge;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.permission.PermissionEngine;
import io.codepilot.core.permission.PermissionRule;
import io.codepilot.core.session.*;
import io.codepilot.core.session.Message;
import io.codepilot.core.session.context.ContextBudget;
import io.codepilot.core.session.context.ContextCompactor;
import io.codepilot.core.session.prompt.PromptBuilder;
import io.codepilot.core.session.recovery.DoomLoopDetector;
import io.codepilot.core.session.tool.ToolRegistry;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.messages.*;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Schedulers;

/**
 * Core agent loop with streaming LLM output, function-calling-based tool execution, permission
 * enforcement, early compaction, and doom loop recovery.
 *
 * <p>Supports configuration-driven agents (build/plan/compose) through AgentDefinition. Tools use
 * Spring AI's OpenAI function-calling via {@code OpenAiChatOptions.withFunctions()}. LOCAL tools
 * are executed by backend, REMOTE tools are dispatched to plugin via SSE events.
 *
 * <p>Emits v2 envelope protocol events: turn.start to step.start to text.delta to tool.call to
 * tool.result to step.end to turn.end.
 */
public class AgentLoop {
  private static final Logger log = LoggerFactory.getLogger(AgentLoop.class);
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final int DOOM_LOOP_LOOKBACK = 12;
  private static final int DOOM_LOOP_MAX_RECURRENCE = 3;
  private static final Duration TOOL_RESULT_TIMEOUT = Duration.ofMinutes(5);

  private final SessionState session;
  private final AgentDefinition agent;
  private final ChatClientFactory chatClientFactory;
  private final PromptBuilder promptBuilder;
  private final ContextBudget contextBudget;
  private final ContextCompactor contextCompactor;
  private final ToolRegistry toolRegistry;
  private final GoalJudge goalJudge;
  private final io.codepilot.core.session.checkpoint.CheckpointWriter checkpointWriter;
  private final io.codepilot.core.session.result.ToolResultSanitizer resultSanitizer;
  private final DoomLoopDetector doomDetector;
  private final PermissionEngine permissionEngine;
  private final AtomicBoolean stopSignal = new AtomicBoolean(false);
  private final AtomicInteger envelopeSeq = new AtomicInteger(0);

  /** The turn at which doom-loop recovery was last injected; 0 means no recent recovery. */
  private final AtomicInteger doomLoopRecoveryTurn = new AtomicInteger(0);

  // ── Remote tool result waiting ──
  private final Map<String, Sinks.One<Boolean>> permissionSinks = new ConcurrentHashMap<>();
  private final Map<String, Sinks.One<io.codepilot.core.agent.tool.ToolResult>> remoteToolResults =
      new ConcurrentHashMap<>();

  public AgentLoop(
      SessionState session,
      ChatClientFactory chatClientFactory,
      PromptBuilder promptBuilder,
      ContextBudget contextBudget,
      ContextCompactor contextCompactor,
      ToolRegistry toolRegistry,
      GoalJudge goalJudge,
      io.codepilot.core.session.checkpoint.CheckpointWriter checkpointWriter,
      io.codepilot.core.session.result.ToolResultSanitizer resultSanitizer,
      AgentDefinition agent,
      PermissionEngine permissionEngine) {
    this.session = session;
    this.agent = agent;
    this.chatClientFactory = chatClientFactory;
    this.promptBuilder = promptBuilder;
    this.contextBudget = contextBudget;
    this.contextCompactor = contextCompactor;
    this.toolRegistry = toolRegistry;
    this.goalJudge = goalJudge;
    this.checkpointWriter = checkpointWriter;
    this.resultSanitizer = resultSanitizer;
    this.permissionEngine = permissionEngine;
    this.doomDetector = new DoomLoopDetector(DOOM_LOOP_MAX_RECURRENCE, DOOM_LOOP_LOOKBACK);
  }

  public void stop() {
    stopSignal.set(true);
  }

  /** Called by SessionService when the plugin responds to a permission request. */
  public void respondPermission(String callId, boolean approved) {
    var sink = permissionSinks.remove(callId);
    if (sink != null) {
      sink.tryEmitValue(approved);
    }
  }

  /** Called by SessionService when the plugin POSTs a tool result back. */
  public void onToolResult(String toolCallId, boolean ok, String result, boolean userSkipped) {
    var sink = remoteToolResults.get(toolCallId);
    if (sink != null) {
      io.codepilot.core.agent.tool.ToolResult tr =
          new io.codepilot.core.agent.tool.ToolResult(ok, result);
      sink.tryEmitValue(tr);
      remoteToolResults.remove(toolCallId);
      log.debug("Tool result received for {}: {} userSkipped={}", toolCallId, ok, userSkipped);

      // When the user explicitly skips a tool call (e.g. "skip" on a shell command),
      // inject a system message telling the LLM NOT to retry that category of action.
      // This is different from "deny" where the user rejected a specific command but
      // the agent may try an alternative approach. "Skip" means the user wants to
      // skip this step entirely and move on.
      if (userSkipped && !ok) {
        String skipDirective =
            "[SYSTEM — USER SKIPPED] The user explicitly skipped this tool call. "
                + "Do NOT retry the same type of operation (e.g. if the user skipped an install "
                + "command, do not try another install command with different flags or mirrors). "
                + "The user wants to skip this step entirely. Continue with the rest of the task "
                + "without this step, or explain what you need from the user to proceed.";
        session.addUserMessage(skipDirective);
        log.info("User-skip directive injected for session {}", session.getSessionId());
      }
    } else {
      log.warn("No pending sink for toolCallId {}", toolCallId);
    }
  }

  public Flux<StreamEvent> run() {
    return Flux.defer(
        () -> {
          session.setStatus(SessionStatus.RUNNING);
          int maxTurns = agent.maxSteps();
          return Flux.range(0, maxTurns)
              .concatMap(this::executeTurnFlux)
              .takeUntil(event -> event.type() == StreamEvent.Type.DONE)
              .concatWith(Flux.defer(() -> Flux.just(buildDoneEvent())))
              .doOnComplete(this::onComplete)
              .doOnError(this::onError);
        });
  }

  private Flux<StreamEvent> executeTurnFlux(int turn) {
    if (stopSignal.get() || session.shouldStop() || session.isTerminal()) {
      if (stopSignal.get()) {
        session.setTerminalReason(SessionState.TerminalReason.USER_STOPPED);
        session.setStopped(true);
      }
      return Flux.empty();
    }
    session.incrementTurn();

    int level = contextBudget.compactionLevel(session.getEstimatedTokens());
    if (level > 0) {
      double util = (double) session.getEstimatedTokens() / contextBudget.usableTokens();
      boolean isHeavy = level >= 3;

      // Only write checkpoints at medium+ utilization (level >= 2, i.e. 45%+).
      // Writing checkpoints too early (at 20%) causes a vicious cycle in complex tasks:
      // checkpoint writes consume tokens → context grows → triggers another checkpoint →
      // rebuild drops context → LLM re-reads files → cycle repeats.
      //
      // Additionally, skip checkpoint writing for 2 turns after a doom-loop recovery,
      // because the checkpoint itself consumes tokens which worsens context pressure,
      // and rebuild after recovery causes the LLM to lose the recovery directive context.
      int turnsSinceRecovery = session.getTurnCount() - doomLoopRecoveryTurn.get();
      boolean skipCheckpoint = turnsSinceRecovery > 0 && turnsSinceRecovery <= 2;

      String checkpointText = null;
      if (level >= 2 && !skipCheckpoint) {
        try {
          var ckpt = checkpointWriter.writeCheckpoint(session, util);
          if (ckpt != null) checkpointText = ckpt.content();
        } catch (Exception e) {
          log.warn("Checkpoint write failed, continuing with compaction only", e);
        }
      } else if (skipCheckpoint) {
        log.info("Skipping checkpoint for session {} — doom-loop recovery was {} turns ago",
            session.getSessionId(), turnsSinceRecovery);
      }

      if (isHeavy && checkpointText != null) {
        var cycleResult =
            new io.codepilot.core.session.checkpoint.CycleManager()
                .rebuild(session, checkpointText);
        return Flux.just(
                StreamEvent.checkpointWriter(session.getTurnCount(), util, checkpointText),
                StreamEvent.compacted(cycleResult.messagesBefore(), cycleResult.messagesAfter(), 0))
            .concatWith(doTurnCore());
      }

      var r = contextCompactor.compact(session);
      Flux<StreamEvent> compactedEv =
          Flux.just(StreamEvent.compacted(r.messagesBefore(), r.messagesAfter(), r.tokensSaved()));
      if (checkpointText != null) {
        return Flux.just(StreamEvent.checkpointWriter(session.getTurnCount(), util, checkpointText))
            .concatWith(compactedEv)
            .concatWith(doTurnCore());
      }
      return compactedEv.concatWith(doTurnCore());
    }
    return doTurnCore();
  }

  private Flux<StreamEvent> doTurnCore() {
    Flux<StreamEvent> prefix = Flux.empty();

    // Cooldown: skip doom-loop detection for a few turns after injecting recovery,
    // to avoid re-triggering on the same tool calls that are still in the lookback window.
    // The cooldown should be shorter than the lookback window so that if the agent
    // truly loops again after recovery, it will still be caught.
    int turnsSinceRecovery = session.getTurnCount() - doomLoopRecoveryTurn.get();
    boolean inCooldown = doomLoopRecoveryTurn.get() > 0 && turnsSinceRecovery <= 3;

    var doomResult = inCooldown ? DoomLoopDetector.DoomLoopResult.none() : doomDetector.detect(session.getMessages());
    if (doomResult.detected()) {
      log.warn("Doom-loop detected for session {}, injecting recovery directive", session.getSessionId());
      doomLoopRecoveryTurn.set(session.getTurnCount());

      // Build a targeted recovery directive with specifics about which tool is looping
      // and an explicit instruction to use alternative approaches.
      String toolInfo = "";
      if (!doomResult.toolName().isBlank()) {
        toolInfo = " You have called '" + doomResult.toolName() + "' " + doomResult.count()
            + " times in the last " + doomResult.window() + " messages — this is a loop."
            + " You MUST NOT call '" + doomResult.toolName() + "' again."
            + " Instead, use a completely different approach: if you were trying to install"
            + " dependencies, write the code and requirements file first instead;"
            + " if you were searching for something, try a different tool or path;"
            + " if you were running commands, write the files directly without executing.";
      }

      session.addUserMessage(
          "[SYSTEM — LOOP DETECTED] You are repeating the same actions."
              + toolInfo
              + " If you are stuck, explain the situation to the user and ask for guidance."
              + " Do NOT retry the same approach — change your strategy now.");

      // Also emit an ask_permission event so the UI can notify the user
      prefix = Flux.just(
          StreamEvent.askPermission(
              "doom_loop",
              "doom_loop",
              "",
              "Doom-loop detected: the agent is repeating the same actions. A recovery directive has been injected. Continue anyway?"));
    }

    String systemPrompt = promptBuilder.build(session);
    ensureSystemPrompt(systemPrompt);
    return prefix.concatWith(callLlmStreaming());
  }

  // ══════ Streaming LLM call with function calling ══════

  private Flux<StreamEvent> callLlmStreaming() {
    ChatClientFactory.ResolvedClient resolved;
    try {
      resolved =
          chatClientFactory.resolve(
              session.getModelId(),
              session.getModelSource() != null
                  ? ModelSource.valueOf(session.getModelSource())
                  : ModelSource.GROUP,
              session.getUserId());
    } catch (Exception e) {
      log.error("Failed to resolve client for session {}", session.getSessionId(), e);
      return Flux.just(StreamEvent.error("Failed to resolve model client", "CLIENT_ERROR"));
    }

    resolved.startRequest();
    var springMessages = convertMessages();
    OpenAiChatModel chatModel = resolved.chatModel();

    // ── Native function-calling: register tools so the model emits structured
    //    tool_call responses instead of text-based ```tool_call blocks.
    //    We disable auto-execution (internalToolExecutionEnabled=false) and
    //    handle tool dispatch ourselves to preserve remote/local routing,
    //    permission enforcement, and plugin-side execution. ──
    var optionsBuilder = OpenAiChatOptions.builder();
    if (agent.temperature() != null) optionsBuilder.temperature(agent.temperature());
    if (agent.topP() != null) optionsBuilder.topP(agent.topP());
    optionsBuilder.internalToolExecutionEnabled(false);

    // Register tools as OpenAI FunctionTool definitions so the model uses native
    // function calling. We build lightweight definitions — actual execution is
    // handled by our own tool dispatch pipeline in processToolCall().
    var override = session.getPermissionOverride();
    java.util.List<OpenAiApi.FunctionTool> functionTools = new java.util.ArrayList<>();
    for (var tool : toolRegistry.getDefinitions()) {
      if (!isToolAdvertised(agent, override, tool.name())) continue;
      try {
        var paramSchema = tool.parametersSchema();
        String paramJson =
            paramSchema instanceof Map
                ? MAPPER.writeValueAsString(paramSchema)
                : "{\"type\":\"object\",\"properties\":{}}";
        functionTools.add(
            new OpenAiApi.FunctionTool(
                new OpenAiApi.FunctionTool.Function(
                    tool.description(), tool.name(), paramJson)));
      } catch (Exception e) {
        log.debug("Failed to register tool {} definition: {}", tool.name(), e.getMessage());
      }
    }

    // Also register session-scoped MCP tools
    var mcpTools = session.getMcpTools();
    if (mcpTools != null) {
      for (var t : mcpTools) {
        Object nameObj = t.get("name");
        if (nameObj == null) continue;
        String name = nameObj.toString();
        if (name.isBlank()) continue;
        if (permissionEngine.evaluate(agent, override, name, "*")
            == PermissionRule.Action.DENY) continue;
        try {
          Object schema = t.getOrDefault("inputSchema", t.get("parametersSchema"));
          String paramJson =
              schema != null
                  ? MAPPER.writeValueAsString(schema)
                  : "{\"type\":\"object\",\"properties\":{}}";
          functionTools.add(
              new OpenAiApi.FunctionTool(
                  new OpenAiApi.FunctionTool.Function(
                      t.getOrDefault("description", "MCP tool").toString(), name, paramJson)));
        } catch (Exception e) {
          log.debug("Failed to register MCP tool {} definition: {}", name, e.getMessage());
        }
      }
    }

    if (!functionTools.isEmpty()) {
      optionsBuilder.tools(functionTools);
    }

    var chatOptions = optionsBuilder.build();

    Prompt prompt = new Prompt(springMessages, chatOptions);

    StringBuilder fullText = new StringBuilder();
    final Message.TokenUsage[] usageHolder = {Message.TokenUsage.empty()};
    // Accumulate structured tool calls from streaming chunks
    final java.util.List<org.springframework.ai.chat.messages.AssistantMessage.ToolCall>
        accumulatedToolCalls =
            java.util.Collections.synchronizedList(new java.util.ArrayList<>());

    return chatModel
        .stream(prompt)
        .flatMap(
            chunk -> {
              captureUsage(chunk, usageHolder);
              String deltaText = extractDelta(chunk);
              if (deltaText != null && !deltaText.isEmpty()) {
                fullText.append(deltaText);
                return Flux.just(StreamEvent.text(deltaText));
              }
              // Extract structured tool calls from streaming chunks
              extractToolCallsFromChunk(chunk, accumulatedToolCalls);
              return Flux.empty();
            })
        .concatWith(
            Flux.defer(
                () ->
                    processAfterStreamWithToolCalls(
                        fullText.toString(), accumulatedToolCalls, resolved, usageHolder[0])))
        .doOnError(
            e -> {
              resolved.endRequest(false, 0);
              log.error("LLM stream failed for session {}", session.getSessionId(), e);
            })
        .onErrorResume(
            e ->
                Flux.just(
                    StreamEvent.error("LLM call failed: " + e.getMessage(), "LLM_ERROR")));
  }

  /** Extract structured tool calls from a streaming response chunk. */
  private void extractToolCallsFromChunk(
      org.springframework.ai.chat.model.ChatResponse chunk,
      java.util.List<org.springframework.ai.chat.messages.AssistantMessage.ToolCall>
          accumulated) {
    try {
      if (chunk == null || chunk.getResult() == null || chunk.getResult().getOutput() == null) {
        return;
      }
      var output = chunk.getResult().getOutput();
      var toolCalls = output.getToolCalls();
      if (toolCalls != null && !toolCalls.isEmpty()) {
        for (var tc : toolCalls) {
          // Merge with existing: the id and name come in the first chunk,
          // arguments are appended across subsequent chunks
          var existing =
              accumulated.stream()
                  .filter(a -> a.id() != null && a.id().equals(tc.id()) && !a.id().isEmpty())
                  .findFirst();
          if (existing.isPresent()) {
            // Concatenate arguments
            var old = existing.get();
            if (tc.arguments() != null && !tc.arguments().isEmpty()) {
              var merged =
                  new org.springframework.ai.chat.messages.AssistantMessage.ToolCall(
                      old.id(), old.type(), old.name(), old.arguments() + tc.arguments());
              accumulated.remove(old);
              accumulated.add(merged);
            }
          } else {
            accumulated.add(tc);
          }
        }
      }
    } catch (Exception e) {
      log.debug("Failed to extract tool calls from streaming chunk: {}", e.getMessage());
    }
  }

  /** Whether a tool should be advertised to the active agent. */
  private boolean isToolAdvertised(
      AgentDefinition agent,
      io.codepilot.core.permission.PermissionRuleset override,
      String toolName) {
    if (!permissionEngine.isToolAllowed(agent, toolName)) return false;
    return permissionEngine.evaluate(agent, override, toolName, "*") != PermissionRule.Action.DENY;
  }

  /**
   * Process the completed stream, preferring native structured tool calls over text-parsed ones.
   */
  private Flux<StreamEvent> processAfterStreamWithToolCalls(
      String text,
      java.util.List<org.springframework.ai.chat.messages.AssistantMessage.ToolCall>
          nativeToolCalls,
      ChatClientFactory.ResolvedClient resolved,
      Message.TokenUsage usage) {

    // Convert native tool calls to our ToolCallEntry format
    List<Message.ToolCallEntry> toolCalls = new ArrayList<>();
    boolean hasNativeToolCalls = !nativeToolCalls.isEmpty();

    if (hasNativeToolCalls) {
      for (var tc : nativeToolCalls) {
        String name = tc.name();
        Map<String, Object> args = Map.of();
        if (tc.arguments() != null && !tc.arguments().isBlank()) {
          try {
            JsonNode argsNode = MAPPER.readTree(tc.arguments());
            args = MAPPER.convertValue(argsNode, Map.class);
          } catch (Exception e) {
            log.warn("Failed to parse native tool call arguments for {}: {}", name, e.getMessage());
            // Try to use arguments as a single string value
            args = Map.of("rawArguments", tc.arguments());
          }
        }
        toolCalls.add(new Message.ToolCallEntry(tc.id(), name, args));
      }
      log.info(
          "processAfterStream: used {} native tool call(s) from function-calling API",
          toolCalls.size());
    } else {
      // Fallback: parse tool calls from text (for models that don't support function calling)
      parseToolCallsFromText(text, toolCalls);
    }

    resolved.endRequest(true, usage.totalTokens());
    session.addAssistantMessage(text, toolCalls, null, usage);

    if (!usage.equals(Message.TokenUsage.empty())) {
      session.addTokenUsage(usage.inputTokens(), usage.outputTokens(), 0.0);
      session.addEstimatedTokens(usage.totalTokens());
    }

    log.info(
        "processAfterStream: session={} turn={} textLen={} toolCalls={} native={} explicitGoal={} goalFailCount={}",
        session.getSessionId(),
        session.getTurnCount(),
        text != null ? text.length() : 0,
        toolCalls.size(),
        hasNativeToolCalls,
        session.hasExplicitGoalCondition(),
        session.getGoalFailCount());

    if (toolCalls.isEmpty()) {
      String textOutsideToolCalls = stripToolCallBlocks(text);
      if (!session.hasExplicitGoalCondition()
          && textOutsideToolCalls.length() >= SUBSTANTIAL_TEXT_THRESHOLD) {
        log.info(
            "processAfterStream: no explicit goal + substantial text ({} chars) -> TASK_COMPLETE",
            textOutsideToolCalls.length());
        session.setTerminalReason(SessionState.TerminalReason.TASK_COMPLETE);
        return Flux.just(
            StreamEvent.done(
                SessionState.TerminalReason.TASK_COMPLETE,
                session.getTurnCount(),
                session.getTotalInputTokens(),
                session.getTotalOutputTokens(),
                session.getTotalCost(),
                null));
      }

      log.info("processAfterStream: no tool calls, running goal evaluation");
      return evaluateGoalAsync()
          .flatMapMany(
              verdict -> {
                log.info(
                    "processAfterStream: goal verdict satisfied={} confidence={} reason={}",
                    verdict.satisfied(),
                    verdict.confidence(),
                    verdict.reason());
                List<StreamEvent> events = new ArrayList<>();
                events.add(
                    StreamEvent.goalEvaluation(
                        verdict.satisfied(),
                        verdict.confidence(),
                        verdict.reason(),
                        verdict.remainingWork()));
                if (verdict.satisfied()) {
                  session.setTerminalReason(SessionState.TerminalReason.TASK_COMPLETE);
                  session.resetGoalFailCount();
                } else {
                  session.incrementGoalFailCount();
                  if (session.getGoalFailCount() >= MAX_GOAL_FAIL_COUNT) {
                    log.warn(
                        "processAfterStream: goal failed {} consecutive times, terminating as GOAL_NOT_MET",
                        session.getGoalFailCount());
                    session.setTerminalReason(SessionState.TerminalReason.GOAL_NOT_MET);
                    events.add(
                        StreamEvent.done(
                            SessionState.TerminalReason.GOAL_NOT_MET,
                            session.getTurnCount(),
                            session.getTotalInputTokens(),
                            session.getTotalOutputTokens(),
                            session.getTotalCost(),
                            "Goal not met after "
                                + session.getGoalFailCount()
                                + " evaluations: "
                                + verdict.reason()));
                  } else {
                    log.info(
                        "processAfterStream: goal not satisfied (failCount={}), injecting continuation message",
                        session.getGoalFailCount());
                    session.addUserMessage(
                        "[Goal evaluation] Not yet satisfied: "
                            + verdict.reason()
                            + ". Remaining: "
                            + (verdict.remainingWork().isBlank()
                                ? "unknown"
                                : verdict.remainingWork()));
                  }
                }
                return Flux.fromIterable(events);
              });
    }

    log.info("processAfterStream: processing {} tool call(s)", toolCalls.size());
    // Process tool calls reactively — each remote/permission-gated call is non-blocking.
    Flux<StreamEvent> toolEvents = Flux.empty();
    for (var tc : toolCalls) {
      toolEvents = toolEvents.concatWith(processToolCall(tc));
    }
    return toolEvents;
  }

  /** Extract the text delta from a streaming chat response chunk. */
  private static String extractDelta(org.springframework.ai.chat.model.ChatResponse chunk) {
    if (chunk == null || chunk.getResult() == null || chunk.getResult().getOutput() == null) {
      return null;
    }
    return chunk.getResult().getOutput().getText();
  }

  /** Capture token usage from a streaming chunk's metadata if present. */
  private static void captureUsage(
      org.springframework.ai.chat.model.ChatResponse chunk, Message.TokenUsage[] holder) {
    try {
      if (chunk == null || chunk.getMetadata() == null || chunk.getMetadata().getUsage() == null) {
        return;
      }
      var u = chunk.getMetadata().getUsage();
      Integer in = u.getPromptTokens();
      Integer out = u.getCompletionTokens();
      if ((in != null && in > 0) || (out != null && out > 0)) {
        holder[0] = new Message.TokenUsage(in != null ? in : 0, out != null ? out : 0, 0, 0, 0);
      }
    } catch (Exception ignore) {
      // Usage is best-effort; some providers omit it during streaming.
    }
  }

  private Flux<StreamEvent> processAfterStream(
      String text, ChatClientFactory.ResolvedClient resolved, Message.TokenUsage usage) {
    // Parse tool calls from the accumulated text (the full LLM response)
    List<Message.ToolCallEntry> toolCalls = new ArrayList<>();
    parseToolCallsFromText(text, toolCalls);

    resolved.endRequest(true, usage.totalTokens());
    session.addAssistantMessage(text, toolCalls, null, usage);

    if (!usage.equals(Message.TokenUsage.empty())) {
      session.addTokenUsage(usage.inputTokens(), usage.outputTokens(), 0.0);
      session.addEstimatedTokens(usage.totalTokens());
    }

    log.info(
        "processAfterStream: session={} turn={} textLen={} toolCalls={} explicitGoal={} goalFailCount={}",
        session.getSessionId(),
        session.getTurnCount(),
        text != null ? text.length() : 0,
        toolCalls.size(),
        session.hasExplicitGoalCondition(),
        session.getGoalFailCount());

    if (toolCalls.isEmpty()) {
      String textOutsideToolCalls = stripToolCallBlocks(text);
      if (!session.hasExplicitGoalCondition()
          && textOutsideToolCalls.length() >= SUBSTANTIAL_TEXT_THRESHOLD) {
        log.info(
            "processAfterStream: no explicit goal + substantial text ({} chars) -> TASK_COMPLETE",
            textOutsideToolCalls.length());
        session.setTerminalReason(SessionState.TerminalReason.TASK_COMPLETE);
        return Flux.just(
            StreamEvent.done(
                SessionState.TerminalReason.TASK_COMPLETE,
                session.getTurnCount(),
                session.getTotalInputTokens(),
                session.getTotalOutputTokens(),
                session.getTotalCost(),
                null));
      }

      log.info("processAfterStream: no tool calls, running goal evaluation");
      return evaluateGoalAsync().flatMapMany(verdict -> {
        log.info(
            "processAfterStream: goal verdict satisfied={} confidence={} reason={}",
            verdict.satisfied(),
            verdict.confidence(),
            verdict.reason());
        List<StreamEvent> events = new ArrayList<>();
        events.add(
            StreamEvent.goalEvaluation(
                verdict.satisfied(),
                verdict.confidence(),
                verdict.reason(),
                verdict.remainingWork()));
        if (verdict.satisfied()) {
          session.setTerminalReason(SessionState.TerminalReason.TASK_COMPLETE);
          session.resetGoalFailCount();
        } else {
          session.incrementGoalFailCount();
          if (session.getGoalFailCount() >= MAX_GOAL_FAIL_COUNT) {
            log.warn(
                "processAfterStream: goal failed {} consecutive times, terminating as GOAL_NOT_MET",
                session.getGoalFailCount());
            session.setTerminalReason(SessionState.TerminalReason.GOAL_NOT_MET);
            events.add(
                StreamEvent.done(
                    SessionState.TerminalReason.GOAL_NOT_MET,
                    session.getTurnCount(),
                    session.getTotalInputTokens(),
                    session.getTotalOutputTokens(),
                    session.getTotalCost(),
                    "Goal not met after " + session.getGoalFailCount() + " evaluations: "
                        + verdict.reason()));
          } else {
            log.info(
                "processAfterStream: goal not satisfied (failCount={}), injecting continuation message",
                session.getGoalFailCount());
            session.addUserMessage(
                "[Goal evaluation] Not yet satisfied: "
                    + verdict.reason()
                    + ". Remaining: "
                    + (verdict.remainingWork().isBlank() ? "unknown" : verdict.remainingWork()));
          }
        }
        return Flux.fromIterable(events);
      });
    }

    log.info(
        "processAfterStream: processing {} tool call(s)",
        toolCalls.size());
    // Process tool calls reactively — each remote/permission-gated call is non-blocking.
    Flux<StreamEvent> toolEvents = Flux.empty();
    for (var tc : toolCalls) {
      toolEvents = toolEvents.concatWith(processToolCall(tc));
    }
    return toolEvents;
  }

  /**
   * Strip all ```tool_call {…}``` blocks from the text so we can measure the length of
   * the agent's natural-language output (i.e. the part the user actually sees).
   */
  /**
   * Strip all ```tool_call {…}``` blocks and <tool_call…></tool_call> tags from the text
   * so we can measure the length of the agent's natural-language output.
   */
  private static String stripToolCallBlocks(String text) {
    if (text == null || text.isBlank()) return "";
    String result = stripMarkdownToolCallBlocks(text);
    result = stripXmlToolCallTags(result);
    return result.trim();
  }

  private static String stripMarkdownToolCallBlocks(String text) {
    StringBuilder out = new StringBuilder();
    int from = 0;
    while (true) {
      int marker = text.indexOf(TOOL_CALL_MARKER, from);
      if (marker < 0) {
        out.append(text, from, text.length());
        break;
      }
      out.append(text, from, marker);
      int braceStart = text.indexOf('{', marker + TOOL_CALL_MARKER.length());
      if (braceStart < 0) {
        from = text.length();
        break;
      }
      int braceEnd = matchBalancedBrace(text, braceStart);
      if (braceEnd < 0) {
        from = text.length();
        break;
      }
      int closeFence = text.indexOf("```", braceEnd + 1);
      from = (closeFence >= 0) ? closeFence + 3 : braceEnd + 1;
    }
    return out.toString();
  }

  private static String stripXmlToolCallTags(String text) {
    StringBuilder out = new StringBuilder();
    int from = 0;
    while (true) {
      int tagStart = text.indexOf(TOOL_CALL_XML_OPEN, from);
      if (tagStart < 0) {
        out.append(text, from, text.length());
        break;
      }
      out.append(text, from, tagStart);
      int closeTag = text.indexOf(TOOL_CALL_XML_CLOSE, tagStart);
      from = (closeTag >= 0) ? closeTag + TOOL_CALL_XML_CLOSE.length() : text.length();
    }
    return out.toString();
  }

  private Flux<StreamEvent> processToolCall(Message.ToolCallEntry tc) {
    String argsJson;
    try {
      argsJson = tc.args() != null ? MAPPER.writeValueAsString(tc.args()) : "{}";
    } catch (Exception e) {
      argsJson = "{}";
    }
    Flux<StreamEvent> startEvent = Flux.just(
        StreamEvent.toolCallStart(tc.id(), tc.name(), argsJson));

    boolean isRegistered = toolRegistry.getDefinition(tc.name()).isPresent();
    boolean isSessionMcp = !isRegistered && isSessionMcpTool(tc.name());
    if (!isRegistered && !isSessionMcp) {
      return startEvent.concatWith(Flux.defer(() -> {
        recordResult(tc, false, "Unknown tool: " + tc.name());
        return Flux.just(StreamEvent.toolCallEnd(tc.id(), tc.name(), false, "Unknown tool: " + tc.name()));
      }));
    }

    // Permission: explicit DENY blocks; ASK escalates to the user via the plugin.
    PermissionRule.Action permission =
        permissionEngine.evaluate(agent, session.getPermissionOverride(), tc.name(), "*");
    if (permission == PermissionRule.Action.DENY) {
      return startEvent.concatWith(Flux.defer(() -> {
        recordResult(tc, false, "[Permission denied by policy]");
        return Flux.just(StreamEvent.toolCallEnd(tc.id(), tc.name(), false, "[Permission denied by policy]"));
      }));
    }

    // Allowlist applies only to built-in (registered) tools; MCP tools are gated by permission.
    if (isRegistered && !permissionEngine.isToolAllowed(agent, tc.name())) {
      return startEvent.concatWith(Flux.defer(() -> {
        recordResult(tc, false, "[Tool not in allowlist: " + tc.name() + "]");
        return Flux.just(StreamEvent.toolCallEnd(tc.id(), tc.name(), false, "[Tool not in allowlist: " + tc.name() + "]"));
      }));
    }

    Flux<StreamEvent> afterPermission;
    if (permission == PermissionRule.Action.ASK) {
      // Ask permission reactively — wait on boundedElastic so we don't block the event loop.
      afterPermission = Flux.just(
              StreamEvent.askPermission(
                  tc.id(),
                  tc.name(),
                  argsJson,
                  "Tool '" + tc.name() + "' requires your approval."))
          .concatWith(waitForPermissionAsync(tc.id()).flatMapMany(approved -> {
            if (!approved) {
              recordResult(tc, false, "[Permission denied by user]");
              return Flux.just(
                  StreamEvent.permissionResult(tc.id(), false),
                  StreamEvent.toolCallEnd(tc.id(), tc.name(), false, "[Permission denied by user]"));
            }
            return Flux.just(StreamEvent.permissionResult(tc.id(), true))
                .concatWith(executeAndRecordTool(tc, isSessionMcp));
          }));
    } else {
      afterPermission = executeAndRecordTool(tc, isSessionMcp);
    }

    return startEvent.concatWith(afterPermission);
  }

  /** Execute a tool (remote or local) and record the result. */
  private Flux<StreamEvent> executeAndRecordTool(Message.ToolCallEntry tc, boolean isSessionMcp) {
    boolean remote = isSessionMcp || toolRegistry.isRemote(tc.name());
    if (remote) {
      return waitForRemoteToolResultAsync(tc).flatMapMany(tr -> {
        recordResult(tc, tr.success(), tr.output());
        return Flux.just(StreamEvent.toolCallEnd(tc.id(), tc.name(), tr.success(), tr.output()));
      });
    } else {
      return Flux.defer(() -> {
        io.codepilot.core.agent.tool.ToolResult tr = executeTool(tc);
        recordResult(tc, tr.success(), tr.output());
        return Flux.just(StreamEvent.toolCallEnd(tc.id(), tc.name(), tr.success(), tr.output()));
      });
    }
  }

  /** Wait for a permission response asynchronously, running the block on a bounded elastic scheduler. */
  private Mono<Boolean> waitForPermissionAsync(String callId) {
    Sinks.One<Boolean> sink = Sinks.one();
    permissionSinks.put(callId, sink);
    return sink.asMono()
        .timeout(Duration.ofMinutes(5))
        .onErrorResume(e -> {
          permissionSinks.remove(callId);
          return Mono.just(false);
        });
  }

  /** Wait for a remote tool result asynchronously, running the wait on a bounded elastic scheduler. */
  private Mono<io.codepilot.core.agent.tool.ToolResult> waitForRemoteToolResultAsync(
      Message.ToolCallEntry tc) {
    Sinks.One<io.codepilot.core.agent.tool.ToolResult> sink = Sinks.one();
    remoteToolResults.put(tc.id(), sink);
    return sink.asMono()
        .timeout(TOOL_RESULT_TIMEOUT)
        .onErrorResume(e -> {
          remoteToolResults.remove(tc.id());
          log.warn("Timeout waiting for remote tool result: {} ({})", tc.name(), tc.id());
          return Mono.just(new io.codepilot.core.agent.tool.ToolResult(false, "Tool timed out: " + tc.name()));
        });
  }

  /** Clean a tool result, inject it into context. Detects model-hallucinated results. */
  private void recordResult(
      Message.ToolCallEntry tc, boolean success, String rawOutput) {
    // Detect model-hallucinated results: the model sometimes outputs fake tool results
    // in the format [{"type":"text","text":"..."}] or similar JSON arrays
    String output = rawOutput;
    if (success && isLikelyHallucinatedResult(tc.name(), rawOutput)) {
      log.warn(
          "Tool {} result appears to be model-hallucinated, injecting error: {}",
          tc.name(),
          rawOutput != null && rawOutput.length() > 100
              ? rawOutput.substring(0, 100) + "..."
              : rawOutput);
      output =
          "[VERIFICATION FAILED] The tool result appears to be fabricated by the model, "
              + "not an actual execution result. Please try calling the tool again properly.";
      session.addToolResult(tc.id(), tc.name(), output);
      return;
    }
    var cleaned = resultSanitizer.sanitize(tc.name(), output);
    session.addToolResult(tc.id(), tc.name(), cleaned.content());
    if (cleaned.truncated()) {
      log.debug(
          "Tool {} result cleaned: {} -> {} chars",
          tc.name(),
          cleaned.originalLength(),
          cleaned.content().length());
    }
  }

  /**
   * Detect likely model-hallucinated tool results. The model sometimes outputs
   * fake results in a distinctive JSON format instead of waiting for actual execution.
   */
  private boolean isLikelyHallucinatedResult(String toolName, String result) {
    if (result == null || result.isBlank()) return false;
    String trimmed = result.trim();
    // Hallucinated results often look like: [{"type":"text","text":"Created ..."}]
    // or [{"type":"text","text":"F:/workspace/..."}]
    if (trimmed.startsWith("[{\"type\":\"text\"")
        || trimmed.startsWith("[{\\\"type\\\":\\\"text\\\"")) {
      return true;
    }
    // Hallucinated results for fs.create often say "Created /path/to/file"
    // but the real result is a structured JSON with path and bytes
    if (("fs.create".equals(toolName) || "fs.write".equals(toolName))
        && !trimmed.startsWith("{")
        && (trimmed.startsWith("Created ") || trimmed.startsWith("Wrote "))) {
      return true;
    }
    return false;
  }

  /** Whether the named tool was advertised for this session as an MCP tool. */
  private boolean isSessionMcpTool(String name) {
    var mcp = session.getMcpTools();
    if (mcp == null) return false;
    for (var t : mcp) {
      if (name.equals(t.get("name"))) return true;
    }
    return false;
  }


  private Mono<GoalJudge.Verdict> evaluateGoalAsync() {
    String goalCondition = session.getGoalCondition();
    if (goalCondition == null || goalCondition.isBlank()) {
      String input = session.getInput();
      if (input != null && !input.isBlank()) {
        goalCondition = input;
        session.setGoalCondition(goalCondition);
      } else {
        return Mono.just(new GoalJudge.Verdict(false, 0.3, "No goal condition", "No task to evaluate"));
      }
    }
    return goalJudge.evaluateAsync(
        session.getModelId(),
        session.getModelSource(),
        session.getUserId(),
        goalCondition,
        session.getTurnCount(),
        session.getFilesRead().size(),
        session.getFilesWritten().size(),
        session.getMessages());
  }

  private void ensureSystemPrompt(String systemPrompt) {
    List<Message> msgs = session.getMessages();
    if (msgs.isEmpty()) session.addMessage(Message.system(systemPrompt));
    else if (msgs.get(0).role() == Message.Role.SYSTEM) msgs.set(0, Message.system(systemPrompt));
    else msgs.add(0, Message.system(systemPrompt));
  }

  private static final String TOOL_CALL_MARKER = "```tool_call";

  /** XML-style tool-call tag used by some providers (e.g. DeepSeek). */
  private static final String TOOL_CALL_XML_OPEN = "<tool_call";

  private static final String TOOL_CALL_XML_CLOSE = "</tool_call>";

  /** Consecutive goal-evaluation failures before the loop is forcefully terminated. */
  private static final int MAX_GOAL_FAIL_COUNT = 3;

  /**
   * Minimum non-tool-call text length (in characters) to consider the LLM output as "substantial
   * text addressed to the user". When the agent produces substantial text without any tool calls,
   * it is likely explaining or answering the user directly — skip goal evaluation to avoid
   * immediately overriding the response with a "not yet satisfied" loop.
   */
  private static final int SUBSTANTIAL_TEXT_THRESHOLD = 50;

  private void parseToolCallsFromText(String text, List<Message.ToolCallEntry> calls) {
    if (text == null || text.isBlank()) return;

    // Pass 1: parse the canonical ```tool_call {…}``` blocks
    parseMarkdownToolCalls(text, calls);

    // Pass 2: parse XML-style <tool_call name="…">{…}</tool_call> tags (used by some
    // providers like DeepSeek that do not follow the ```tool_call fence convention).
    parseXmlToolCalls(text, calls);
  }

  /** Parse the canonical ```tool_call {…}``` fence format. */
  private void parseMarkdownToolCalls(String text, List<Message.ToolCallEntry> calls) {
    int from = 0;
    while (true) {
      int marker = text.indexOf(TOOL_CALL_MARKER, from);
      if (marker < 0) break;
      int braceStart = text.indexOf('{', marker + TOOL_CALL_MARKER.length());
      if (braceStart < 0) break;
      int braceEnd = matchBalancedBrace(text, braceStart);
      if (braceEnd < 0) {
        from = braceStart + 1;
        continue;
      }
      String jsonStr = text.substring(braceStart, braceEnd + 1);
      parseToolCallJson(jsonStr, calls);
      from = braceEnd + 1;
    }
  }

  /** Parse XML-style <tool_call name="…">{…}</tool_call> tags. */
  private void parseXmlToolCalls(String text, List<Message.ToolCallEntry> calls) {
    int from = 0;
    while (true) {
      int tagStart = text.indexOf(TOOL_CALL_XML_OPEN, from);
      if (tagStart < 0) break;
      // Extract the "name" attribute from the opening tag
      int tagClose = text.indexOf('>', tagStart + TOOL_CALL_XML_OPEN.length());
      if (tagClose < 0) break;
      String tagContent = text.substring(tagStart + TOOL_CALL_XML_OPEN.length(), tagClose);
      String toolName = "";
      java.util.regex.Matcher nameMatcher =
          java.util.regex.Pattern.compile("name\\s*=\\s*[\"']([^\"']+)[\"']").matcher(tagContent);
      if (nameMatcher.find()) {
        toolName = nameMatcher.group(1);
      }
      // Locate the JSON body after the '>'
      int braceStart = text.indexOf('{', tagClose);
      if (braceStart < 0) {
        from = tagClose + 1;
        continue;
      }
      int braceEnd = matchBalancedBrace(text, braceStart);
      if (braceEnd < 0) {
        from = braceStart + 1;
        continue;
      }
      String jsonStr = text.substring(braceStart, braceEnd + 1);
      parseToolCallJson(jsonStr, calls, toolName);
      // Advance past the closing tag if present
      int closeIdx = text.indexOf(TOOL_CALL_XML_CLOSE, braceEnd);
      from = (closeIdx >= 0) ? closeIdx + TOOL_CALL_XML_CLOSE.length() : braceEnd + 1;
    }
  }

  /** Parse a JSON object into a ToolCallEntry (name extracted from JSON). */
  private void parseToolCallJson(String jsonStr, List<Message.ToolCallEntry> calls) {
    parseToolCallJson(jsonStr, calls, null);
  }

  /** Parse a JSON object into a ToolCallEntry. If fallbackName is non-null it overrides
   *  any "name" field found inside the JSON (for XML-style tags where name is an attribute). */
  private void parseToolCallJson(String jsonStr, List<Message.ToolCallEntry> calls, String fallbackName) {
    try {
      JsonNode json = MAPPER.readTree(jsonStr);
      extractToolCall(json, fallbackName, calls);
    } catch (Exception e) {
      // Some LLMs (e.g. DeepSeek) emit raw newlines inside JSON string values,
      // which is invalid JSON. Try to repair by escaping unescaped newlines
      // inside string literals, then re-parse.
      try {
        String repaired = escapeRawNewlinesInStrings(jsonStr);
        JsonNode json = MAPPER.readTree(repaired);
        extractToolCall(json, fallbackName, calls);
        log.debug("Successfully repaired tool_call JSON with raw newlines");
      } catch (Exception e2) {
        log.warn("Failed to parse tool_call JSON (even after repair): {}", jsonStr, e2);
      }
    }
  }

  private void extractToolCall(JsonNode json, String fallbackName, List<Message.ToolCallEntry> calls) {
    String name = fallbackName != null && !fallbackName.isEmpty() ? fallbackName : json.path("name").asText("");
    JsonNode argsNode = json.path("arguments");
    Map<String, Object> args = argsNode.isObject() ? MAPPER.convertValue(argsNode, Map.class) : Map.of();
    if (!name.isEmpty()) {
      String id = "tc_" + UUID.randomUUID().toString().substring(0, 8);
      calls.add(new Message.ToolCallEntry(id, name, args));
    }
  }

  /**
   * Escape raw newline characters that appear inside JSON string values.
   * Some LLMs emit multi-line string content without proper JSON escaping,
   * e.g. {"command": "python -c "\nprint('hello')\n"} instead of
   * {"command": "python -c \nprint('hello')\n"}.
   * This method walks the JSON text, tracks whether we are inside a quoted
   * string, and replaces literal \n / \r with their escaped equivalents.
   */
  private static String escapeRawNewlinesInStrings(String json) {
    StringBuilder sb = new StringBuilder(json.length() + 64);
    boolean inString = false;
    boolean escaped = false;
    for (int i = 0; i < json.length(); i++) {
      char c = json.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
          sb.append(c);
        } else if (c == '\\') {
          escaped = true;
          sb.append(c);
        } else if (c == '"') {
          inString = false;
          sb.append(c);
        } else if (c == '\n') {
          sb.append("\\n");
        } else if (c == '\r') {
          sb.append("\\r");
        } else if (c == '\t') {
          sb.append("\\t");
        } else {
          sb.append(c);
        }
      } else {
        if (c == '"') {
          inString = true;
        }
        sb.append(c);
      }
    }
    return sb.toString();
  }

  private static int matchBalancedBrace(String s, int start) {
    int depth = 0;
    boolean inString = false;
    boolean escaped = false;
    for (int i = start; i < s.length(); i++) {
      char c = s.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c == '\\') {
          escaped = true;
        } else if (c == '"') {
          inString = false;
        }
      } else if (c == '"') {
        inString = true;
      } else if (c == '{') {
        depth++;
      } else if (c == '}') {
        depth--;
        if (depth == 0) return i;
      }
    }
    return -1;
  }

  private List<org.springframework.ai.chat.messages.Message> convertMessages() {
    List<org.springframework.ai.chat.messages.Message> out = new ArrayList<>();
    for (Message m : session.getMessages()) {
      switch (m.role()) {
        case SYSTEM -> {
          if (m.content() != null && !m.content().isBlank())
            out.add(new SystemMessage(m.content()));
        }
        case USER -> {
          if (m.content() != null && !m.content().isBlank()) out.add(new UserMessage(m.content()));
        }
        case ASSISTANT -> {
          // Include tool calls in the AssistantMessage so the LLM can correlate
          // its previous function-calling requests with the tool results that follow.
          if (m.toolCalls() != null && !m.toolCalls().isEmpty()) {
            List<AssistantMessage.ToolCall> springToolCalls = new ArrayList<>();
            for (var tc : m.toolCalls()) {
              String argsJson;
              try {
                argsJson = tc.args() != null ? MAPPER.writeValueAsString(tc.args()) : "{}";
              } catch (Exception e) {
                argsJson = "{}";
              }
              springToolCalls.add(
                  new AssistantMessage.ToolCall(
                      tc.id() != null ? tc.id() : "tc_" + Integer.toHexString(tc.hashCode()),
                      "function",
                      tc.name(),
                      argsJson));
            }
            out.add(
                AssistantMessage.builder()
                    .content(m.content() != null ? m.content() : "")
                    .toolCalls(springToolCalls)
                    .build());
          } else {
            out.add(
                AssistantMessage.builder()
                    .content(m.content() != null ? m.content() : "")
                    .build());
          }
        }
        case TOOL -> {
          // Use ToolResponseMessage with matching tool_call_id so the LLM can
          // correlate results with its function-calling requests. Converting to
          // UserMessage breaks the protocol and causes the model to re-issue the
          // same tool call because it never sees a proper response.
          String toolCallId = m.toolCallId() != null ? m.toolCallId() : "unknown";
          String toolName = m.toolName() != null ? m.toolName() : "unknown";
          out.add(
              ToolResponseMessage.builder()
                  .responses(
                      List.of(
                          new ToolResponseMessage.ToolResponse(
                              toolCallId, toolName, m.content() != null ? m.content() : "")))
                  .build());
        }
      }
    }
    return out;
  }

  private io.codepilot.core.agent.tool.ToolResult executeTool(Message.ToolCallEntry tc) {
    try {
      var executor = toolRegistry.getExecutor(tc.name());
      if (executor.isEmpty())
        return new io.codepilot.core.agent.tool.ToolResult(false, "Unknown tool: " + tc.name());
      var ctx =
          new io.codepilot.core.agent.tool.ToolCall(
              tc.id(), tc.name(), tc.args(), session.getSessionId());
      var result = executor.get().execute(ctx);
      if (tc.args() != null) {
        Object path = tc.args().get("path");
        if (path != null) {
          if ("fs.read".equals(tc.name()) || "fs.outline".equals(tc.name()))
            session.addFileRead(path.toString());
          else if ("fs.write".equals(tc.name()) || "fs.create".equals(tc.name())
              || "fs.replace".equals(tc.name()) || "fs.delete".equals(tc.name())
              || "fs.move".equals(tc.name()) || "fs.applyPatch".equals(tc.name()))
            session.addFileWritten(path.toString());
        }
      }
      return result;
    } catch (Exception e) {
      log.error("Tool {} ({}) failed", tc.name(), tc.id(), e);
      return new io.codepilot.core.agent.tool.ToolResult(false, "Tool error: " + e.getMessage());
    }
  }

  private StreamEvent buildDoneEvent() {
    var reason =
        session.getTerminalReason() != null
            ? session.getTerminalReason()
            : SessionState.TerminalReason.TASK_COMPLETE;
    return StreamEvent.done(
        reason,
        session.getTurnCount(),
        session.getTotalInputTokens(),
        session.getTotalOutputTokens(),
        session.getTotalCost(),
        null);
  }

  private void onComplete() {
    session.setStatus(SessionStatus.COMPLETED);
    log.info("Session {} completed -- turns={}", session.getSessionId(), session.getTurnCount());
  }

  private void onError(Throwable error) {
    session.setStatus(SessionStatus.ERROR);
    session.setTerminalReason(SessionState.TerminalReason.ERROR);
    log.error("Session {} failed", session.getSessionId(), error);
  }
}
