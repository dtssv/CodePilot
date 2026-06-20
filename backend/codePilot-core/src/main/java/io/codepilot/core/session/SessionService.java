package io.codepilot.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.agent.AgentLoop;
import io.codepilot.core.agent.AgentLoopFactory;
import io.codepilot.core.agent.maxmode.MaxModeService;
import io.codepilot.core.deploy.RunLifecycleRegistry;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.safety.RedactionService;
import io.codepilot.core.safety.SystemPromptLeakDetector;
import io.codepilot.core.session.context.ContextBudget;
import io.codepilot.core.session.memory.MemoryService;
import io.codepilot.core.session.prompt.PromptBuilder;
import io.codepilot.core.session.tool.ToolRegistry;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Schedulers;

/**
 * Central service for task execution.
 *
 * <p>This is the single entry point for all agent runs. It:
 *
 * <ul>
 *   <li>Creates or retrieves a session
 *   <li>Loads relevant memories
 *   <li>Delegates to AgentLoop for execution
 *   <li>Persists sessions and envelopes to MySQL
 *   <li>Routes tool results from the plugin back to the AgentLoop
 * </ul>
 */
@Service
public class SessionService {

  private static final Logger log = LoggerFactory.getLogger(SessionService.class);

  private final AgentLoopFactory loopFactory;
  private final ChatClientFactory chatClientFactory;
  private final PromptBuilder promptBuilder;
  private final ToolRegistry toolRegistry;
  private final MemoryService memoryService;
  private final ContextBudget contextBudget;
  private final RedactionService redaction;
  private final SystemPromptLeakDetector leakDetector;
  private final RunLifecycleRegistry runRegistry;
  private final ObjectMapper mapper;
  private final SessionRepository sessionRepository;
  private final MessageRepository messageRepository;
  private final EnvelopeStore envelopeStore;
  private final MaxModeService maxModeService;

  /** Active agent loops keyed by session ID, for stop propagation and tool result routing. */
  private final ConcurrentHashMap<String, AgentLoop> activeLoops = new ConcurrentHashMap<>();

  /** Per-session envelope seq counter for v2 protocol. */
  private final ConcurrentHashMap<String, AtomicInteger> seqCounters = new ConcurrentHashMap<>();

  public SessionService(
      AgentLoopFactory loopFactory,
      ChatClientFactory chatClientFactory,
      PromptBuilder promptBuilder,
      ToolRegistry toolRegistry,
      MemoryService memoryService,
      ContextBudget contextBudget,
      RedactionService redaction,
      SystemPromptLeakDetector leakDetector,
      RunLifecycleRegistry runRegistry,
      ObjectMapper mapper,
      SessionRepository sessionRepository,
      MessageRepository messageRepository,
      EnvelopeStore envelopeStore,
      MaxModeService maxModeService) {
    this.loopFactory = loopFactory;
    this.chatClientFactory = chatClientFactory;
    this.promptBuilder = promptBuilder;
    this.toolRegistry = toolRegistry;
    this.memoryService = memoryService;
    this.contextBudget = contextBudget;
    this.redaction = redaction;
    this.leakDetector = leakDetector;
    this.runRegistry = runRegistry;
    this.mapper = mapper;
    this.sessionRepository = sessionRepository;
    this.messageRepository = messageRepository;
    this.envelopeStore = envelopeStore;
    this.maxModeService = maxModeService;
  }

  /** Run a task and stream events back as SSE. */
  public Flux<ServerSentEvent<String>> run(RunRequest request, String userId) {
    var verdict = leakDetector.detect(request.input());
    if (verdict.blocked()) {
      return Flux.just(
          sseError("Request blocked by safety policy."),
          sseDone(SessionState.TerminalReason.ERROR));
    }

    String sessionId =
        request.sessionId() != null && !request.sessionId().isBlank()
            ? request.sessionId()
            : UUID.randomUUID().toString();

    final String effectiveSessionId =
        request.intent() == RunRequest.Intent.FORK && request.sessionId() != null
            ? request.sessionId() + "_fork_" + UUID.randomUUID().toString().substring(0, 8)
            : sessionId;

    SessionState session = buildSession(effectiveSessionId, request, userId);

    // Load relevant memories
    String memoryContext =
        memoryService.formatForPrompt(
            memoryService.loadRelevant(request.input(), effectiveSessionId));
    session.setMemoryContext(memoryContext);

    // Set current agent from mode
    if (request.mode() != null) {
      session.setCurrentAgent(request.mode());
    }

    // Max Mode: best-of-N plan sampling + judge, injected before the main loop runs.
    if (request.isMaxMode()) {
      maxModeService
          .selectBestPlan(session, request.maxModeSampleCount())
          .ifPresent(
              plan ->
                  session.addSystemMessage(
                      "<max_mode_plan>\nThe following plan was selected as the strongest of "
                          + request.maxModeSampleCount()
                          + " candidates. Follow it unless you discover a concrete reason to"
                          + " deviate.\n\n"
                          + plan
                          + "\n</max_mode_plan>"));
    }

    // MCP tools and permission overrides are carried on the SessionState (set in
    // buildSession); the prompt's tool layer advertises the session's MCP tools and the
    // AgentLoop dispatches them to the plugin as REMOTE, while the PermissionEngine
    // consults the per-session override ruleset during tool evaluation.

    // Create the agent loop
    AgentLoop loop = loopFactory.create(session);

    // Stream events (persisting each envelope for durable reconnect/replay)
    Flux<ServerSentEvent<String>> eventStream =
        loop.run()
            .map(this::toSse)
            .doOnNext(sse -> persistEnvelope(effectiveSessionId, sse))
            .doOnComplete(() -> onSessionComplete(session))
            .doOnError(e -> log.error("Session {} failed", effectiveSessionId, e))
            .doFinally(sig -> seqCounters.remove(effectiveSessionId))
            .subscribeOn(Schedulers.boundedElastic());

    return trackSession(effectiveSessionId, loop, eventStream);
  }

  /** Stop a running session. Propagates the stop signal to the active AgentLoop. */
  public void stop(String sessionId) {
    AgentLoop loop = activeLoops.remove(sessionId);
    if (loop != null) {
      loop.stop();
      log.info("Stop signal sent to AgentLoop for session {}", sessionId);
    }
    runRegistry.unregister(sessionId);
  }

  /**
   * Submit a tool result / permission response for a specific tool call. This allows the agent loop
   * to continue after waiting for the plugin to execute a tool.
   */
  public void respondPermission(String sessionId, String callId, boolean approved) {
    AgentLoop loop = activeLoops.get(sessionId);
    if (loop != null) {
      loop.respondPermission(callId, approved);
      log.info(
          "Permission response: session={} toolCallId={} approved={}", sessionId, callId, approved);
    }
  }

  /**
   * Submit a tool execution result from the plugin. Routes the result to the waiting AgentLoop so
   * it can continue the turn.
   */
  public void onToolResult(String sessionId, String toolCallId, boolean ok, String result,
      boolean userSkipped) {
    AgentLoop loop = activeLoops.get(sessionId);
    if (loop != null) {
      loop.onToolResult(toolCallId, ok, result, userSkipped);
      log.info("Tool result: session={} toolCallId={} ok={} userSkipped={}", sessionId, toolCallId, ok, userSkipped);
    }
  }

  /** Generate a short title for a conversation using the LLM. */
  public String generateTitle(UUID sessionId, String firstMessage) {
    try {
      var resolved =
          chatClientFactory.resolve(null, io.codepilot.core.model.ModelSource.GROUP, null);
      String prompt =
          "Generate a very short title (max 8 words) for a conversation that starts with this"
              + " message. Return ONLY the title text, nothing else.\n\n"
              + "Message: "
              + firstMessage;
      return resolved.chatClient().prompt().user(prompt).call().content();
    } catch (Exception e) {
      log.warn("Failed to generate title for session {}: {}", sessionId, e.getMessage());
      return firstMessage.length() > 50 ? firstMessage.substring(0, 50) + "..." : firstMessage;
    }
  }

  /** Generate a digest/summary of session history using the LLM. */
  public String generateDigest(UUID sessionId, String history) {
    try {
      var resolved =
          chatClientFactory.resolve(null, io.codepilot.core.model.ModelSource.GROUP, null);
      String prompt =
          "Summarize the following session history in 2-3 sentences. "
              + "Return ONLY the summary text, nothing else.\n\nHistory:\n"
              + history;
      return resolved.chatClient().prompt().user(prompt).call().content();
    } catch (Exception e) {
      log.warn("Failed to generate digest for session {}: {}", sessionId, e.getMessage());
      return "Summary unavailable.";
    }
  }

  // ── Internal helpers ──

  private SessionState buildSession(String sessionId, RunRequest request, String userId) {
    SessionState session = new SessionState(sessionId, userId, request.modelId());
    session.setModelSource(request.modelSource() != null ? request.modelSource().name() : null);
    session.setInput(redaction.redact(request.input()));
    session.setWorkspaceRoot(request.workspaceRoot());
    session.setOsHint(request.osHint());
    session.setProjectMeta(request.projectMeta());
    session.setProjectRootHash(request.projectRootHash());
    session.setProjectRules(request.projectRules());
    session.setMcpTools(request.mcpTools());
    if (request.permissionOverrides() != null && !request.permissionOverrides().isEmpty()) {
      session.setPermissionOverride(
          io.codepilot.core.permission.PermissionRuleset.fromConfig(request.permissionOverrides()));
    }

    // Use the explicit goal condition if provided; otherwise derive from input
    if (request.goalCondition() != null && !request.goalCondition().isBlank()) {
      session.setGoalCondition(request.goalCondition());
      session.setExplicitGoalCondition(true);
    } else if (request.input() != null && !request.input().isBlank()) {
      session.setGoalCondition(request.input());
    }

    if (request.options() != null) {
      if (request.options().maxTurns() != null) {
        session.setMaxTurns(request.options().maxTurns());
      }
      if (request.options().language() != null) {
        session.setLanguage(request.options().language());
      }
    }

    // modelLanguage takes precedence over options.language (direct hint from the plugin)
    if (request.modelLanguage() != null && !request.modelLanguage().isBlank()) {
      session.setLanguage(request.modelLanguage());
    }

    // Add user message to history
    session.addUserMessage(session.getInput());

    // Add recent context from client if provided
    if (request.contexts() != null && request.contexts().recent() != null) {
      for (var msg : request.contexts().recent()) {
        if (msg.content() != null && !msg.content().isBlank()) {
          if ("user".equals(msg.role())) {
            session.addUserMessage(msg.content());
          } else if ("assistant".equals(msg.role())) {
            session.addAssistantMessage(msg.content(), null, null, Message.TokenUsage.empty());
          }
        }
      }
    }

    return session;
  }

  private ServerSentEvent<String> toSse(StreamEvent event) {
    try {
      String json = mapper.writeValueAsString(event.payload());
      return ServerSentEvent.<String>builder()
          .event(event.type().name().toLowerCase())
          .data(json)
          .build();
    } catch (Exception e) {
      log.error("Failed to serialize stream event", e);
      return ServerSentEvent.<String>builder()
          .event("error")
          .data("{\"message\":\"Serialization error\"}")
          .build();
    }
  }

  // ── Fork Conversation ───────────────────────────────────────────────

  /**
   * Fork a conversation at {@code forkIndex} and, when a {@code description} is given, immediately
   * start a real agent run on the fork. The {@code fork_created} envelope is emitted first so the
   * plugin can open the new session view before the run streams.
   */
  public Flux<ServerSentEvent<String>> fork(
      String parentSessionId, int forkIndex, String forkMode, String description, String userId) {
    String newSessionId = parentSessionId + "_fork_" + UUID.randomUUID().toString().substring(0, 8);
    SessionState forked = createForkFromParent(parentSessionId, forkIndex, newSessionId, userId);
    if (forked == null) {
      return Flux.just(
          sseError("Parent session not found: " + parentSessionId),
          sseDone(SessionState.TerminalReason.ERROR));
    }
    if (forkMode != null && !forkMode.isBlank()) {
      forked.setCurrentAgent(forkMode);
    }
    ServerSentEvent<String> createdEvent =
        ServerSentEvent.<String>builder()
            .id(newSessionId)
            .event("fork_created")
            .data(
                "{\"newSessionId\":\""
                    + newSessionId
                    + "\",\"parentSessionId\":\""
                    + parentSessionId
                    + "\"}")
            .build();

    // No new instruction → just materialize the fork.
    if (description == null || description.isBlank()) {
      return Flux.just(createdEvent, sseDone(SessionState.TerminalReason.TASK_COMPLETE));
    }

    // Start a real run on the fork with the new instruction.
    forked.setInput(redaction.redact(description));
    forked.addUserMessage(forked.getInput());
    forked.setGoalCondition(description);
    forked.setMemoryContext(
        memoryService.formatForPrompt(memoryService.loadRelevant(description, newSessionId)));

    AgentLoop loop = loopFactory.create(forked);
    Flux<ServerSentEvent<String>> runStream =
        loop.run()
            .map(ev -> withId(toSse(ev), newSessionId))
            .doOnComplete(() -> onSessionComplete(forked))
            .doOnError(e -> log.error("Fork session {} failed", newSessionId, e))
            .subscribeOn(Schedulers.boundedElastic());

    return Flux.just(createdEvent).concatWith(trackSession(newSessionId, loop, runStream));
  }

  /**
   * Fork-batch: create one fork per description from the same parent/index and run them
   * concurrently, merging their event streams. Every envelope carries its fork session id (SSE
   * {@code id}) so the plugin can attribute interleaved events to the right fork.
   */
  public Flux<ServerSentEvent<String>> forkBatch(
      String parentSessionId,
      int forkIndex,
      String forkMode,
      java.util.List<String> descriptions,
      String userId) {
    if (descriptions == null || descriptions.isEmpty()) {
      return Flux.just(
          sseError("fork-batch requires at least one description"),
          sseDone(SessionState.TerminalReason.ERROR));
    }
    java.util.List<Flux<ServerSentEvent<String>>> streams = new java.util.ArrayList<>();
    for (String description : descriptions) {
      streams.add(fork(parentSessionId, forkIndex, forkMode, description, userId));
    }
    return Flux.merge(streams)
        .concatWith(Flux.just(sseDone(SessionState.TerminalReason.TASK_COMPLETE)));
  }

  private ServerSentEvent<String> withId(ServerSentEvent<String> sse, String id) {
    return ServerSentEvent.<String>builder().id(id).event(sse.event()).data(sse.data()).build();
  }

  private SessionState createForkFromParent(
      String parentId, int forkIndex, String newSessionId, String userId) {
    var parentSession = sessionRepository.findById(parentId).orElse(null);
    if (parentSession == null) {
      log.warn("Parent session not found: {}", parentId);
      return null;
    }
    var forkedSession = new SessionState(newSessionId, userId, parentSession.getModelId());
    forkedSession.setModelSource(parentSession.getModelSource());
    forkedSession.setInput(parentSession.getInput() != null ? parentSession.getInput() : "");
    forkedSession.setGoalCondition(parentSession.getGoalCondition());
    forkedSession.setCurrentAgent(parentSession.getCurrentAgent());

    // Copy messages up to fork index (negative index counts back from the end).
    var msgs = parentSession.getMessages();
    int limit = forkIndex >= 0 ? Math.min(forkIndex, msgs.size()) : (msgs.size() + forkIndex);
    for (int i = 0; i < Math.max(0, limit); i++) {
      var m = msgs.get(i);
      forkedSession.addMessage(
          new Message(
              m.id(),
              m.role(),
              m.content(),
              m.toolCalls(),
              m.toolCallId(),
              m.toolName(),
              m.thinking(),
              m.timestamp(),
              m.usage(),
              m.metadata()));
    }
    log.info("Forked session {} from parent {} at index {}", newSessionId, parentId, forkIndex);
    sessionRepository.save(forkedSession);
    return forkedSession;
  }

  private void onSessionComplete(SessionState session) {
    try {
      memoryService.distill(session);
    } catch (Exception e) {
      log.warn("Memory distillation failed for session {}", session.getSessionId(), e);
    }
    try {
      sessionRepository.save(session);
    } catch (Exception e) {
      log.warn("Failed to persist session {}", session.getSessionId(), e);
    }
    session.setStatus(SessionStatus.COMPLETED);
    log.info(
        "Session {} completed: {} turns, {} input tokens, {} output tokens, cost={}",
        session.getSessionId(),
        session.getTurnCount(),
        session.getTotalInputTokens(),
        session.getTotalOutputTokens(),
        String.format("%.4f", session.getTotalCost()));
  }

  private Flux<ServerSentEvent<String>> trackSession(
      String sessionId, AgentLoop loop, Flux<ServerSentEvent<String>> flux) {
    if (sessionId == null || sessionId.isBlank()) {
      return flux;
    }
    return flux.doOnSubscribe(
            s -> {
              runRegistry.register(sessionId, "agent");
              activeLoops.put(sessionId, loop);
            })
        .doFinally(
            signal -> {
              activeLoops.remove(sessionId);
              runRegistry.unregister(sessionId);
            });
  }

  // ── Durable run replay (reconnect support) ──────────────────────────────

  /** Persist an emitted SSE as a durable envelope so reconnecting clients can replay it. */
  private void persistEnvelope(String sessionId, ServerSentEvent<String> sse) {
    if (sessionId == null || sse == null) return;
    try {
      int seq = seqCounters.computeIfAbsent(sessionId, k -> new AtomicInteger(0)).incrementAndGet();
      Object payload = sse.data() != null ? mapper.readTree(sse.data()) : java.util.Map.of();
      envelopeStore.save(
          sessionId,
          new EnvelopeEvent(
              seq,
              sessionId,
              null,
              null,
              System.currentTimeMillis(),
              sse.event() != null ? sse.event() : "message",
              payload));
    } catch (Exception e) {
      log.debug("Failed to persist envelope for session {}: {}", sessionId, e.getMessage());
    }
  }

  /**
   * Replay durable envelopes for a run after a given sequence number. Used by the {@code
   * runs/{id}/stream?afterSeq=} reconnect endpoint.
   */
  public Flux<ServerSentEvent<String>> replay(String sessionId, int afterSeq) {
    var events = envelopeStore.loadAfter(sessionId, afterSeq);
    return Flux.fromIterable(events)
        .map(
            e -> {
              String data;
              try {
                data = mapper.writeValueAsString(e.payload());
              } catch (Exception ex) {
                data = "{}";
              }
              return ServerSentEvent.<String>builder()
                  .id(String.valueOf(e.seq()))
                  .event(e.type())
                  .data(data)
                  .build();
            });
  }

  /** Run status for a session: liveness + the last persisted envelope sequence number. */
  public java.util.Map<String, Object> runStatus(String sessionId) {
    boolean active = activeLoops.containsKey(sessionId);
    var events = envelopeStore.loadAfter(sessionId, 0);
    int lastSeq = events.isEmpty() ? 0 : events.get(events.size() - 1).seq();
    String status = active ? "running" : (lastSeq > 0 ? "completed" : "unknown");
    return java.util.Map.of(
        "sessionId", sessionId,
        "lastSeq", lastSeq,
        "active", active,
        "status", status);
  }

  private ServerSentEvent<String> sseError(String message) {
    return ServerSentEvent.<String>builder()
        .event("error")
        .data("{\"message\":\"" + message.replace("\"", "'") + "\"}")
        .build();
  }

  private ServerSentEvent<String> sseDone(SessionState.TerminalReason reason) {
    return ServerSentEvent.<String>builder()
        .event("done")
        .data("{\"reason\":\"" + reason.name().toLowerCase() + "\"}")
        .build();
  }
}
