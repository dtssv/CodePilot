package io.codepilot.core.conversation;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.audit.AuditInterceptor;
import io.codepilot.core.context.ContextBudgeter;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.prompt.PromptOrchestrator;
import io.codepilot.core.rag.ServerToolExecutor;
import io.codepilot.core.deploy.RunLifecycleRegistry;
import io.codepilot.core.graph.GraphEngineService;
import io.codepilot.core.safety.RedactionService;
import io.codepilot.core.safety.SystemPromptLeakDetector;
import io.codepilot.core.skill.ActivatedSkill;
import io.codepilot.core.skill.UserSkillValidator;
import io.codepilot.core.sse.SseEvents;
import io.codepilot.core.tool.ToolSchemaRegistry;
import io.codepilot.core.skill.SkillRouter;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/** Conversation orchestrator for both chat and agent modes. */
@Service
public class ConversationService {

  private static final Logger log = LoggerFactory.getLogger(ConversationService.class);

  private final ChatClientFactory chatClientFactory;
  private final PromptOrchestrator orchestrator;
  private final ContextBudgeter budgeter;
  private final UserSkillValidator userSkillValidator;
  private final RedactionService redaction;
  private final SystemPromptLeakDetector leakDetector;
  private final ObjectMapper mapper;
  private final EnvelopeStreamParser parser;
  private final ToolResultBus bus;
  private final StopSignalBus stopBus;
  private final SseFactory sse;
  private final ToolSchemaRegistry toolSchemas;
  private final SkillRouter skillRouter;
  private final ServerToolExecutor serverToolExecutor;
  private final AuditInterceptor audit;
  private final GraphEngineService graphEngine;
  private final RunLifecycleRegistry runRegistry;

  public ConversationService(
      ChatClientFactory chatClientFactory,
      PromptOrchestrator orchestrator,
      ContextBudgeter budgeter,
      UserSkillValidator userSkillValidator,
      RedactionService redaction,
      SystemPromptLeakDetector leakDetector,
      ObjectMapper mapper,
      EnvelopeStreamParser parser,
      ToolResultBus bus,
      StopSignalBus stopBus,
      SseFactory sse,
      ToolSchemaRegistry toolSchemas,
      SkillRouter skillRouter,
      ServerToolExecutor serverToolExecutor,
      AuditInterceptor audit,
      GraphEngineService graphEngine,
      RunLifecycleRegistry runRegistry) {
    this.chatClientFactory = chatClientFactory;
    this.orchestrator = orchestrator;
    this.budgeter = budgeter;
    this.userSkillValidator = userSkillValidator;
    this.redaction = redaction;
    this.leakDetector = leakDetector;
    this.mapper = mapper;
    this.parser = parser;
    this.bus = bus;
    this.stopBus = stopBus;
    this.sse = sse;
    this.toolSchemas = toolSchemas;
    this.skillRouter = skillRouter;
    this.serverToolExecutor = serverToolExecutor;
    this.audit = audit;
    this.graphEngine = graphEngine;
    this.runRegistry = runRegistry;
  }

  private Flux<ServerSentEvent<String>> trackSession(
      String sessionId, String runKind, Flux<ServerSentEvent<String>> flux) {
    if (sessionId == null || sessionId.isBlank()) {
      return flux;
    }
    return flux
        .doOnSubscribe(s -> runRegistry.register(sessionId, runKind))
        .doFinally(signal -> runRegistry.unregister(sessionId));
  }

  public Flux<ServerSentEvent<String>> run(ConversationRunRequest req, String userId) {
    SystemPromptLeakDetector.Verdict verdict = leakDetector.detect(req.input());
    if (verdict.blocked()) {
      audit.leakDetectedPre(null, verdict.matchedRule());
      return Flux.just(
          sse.error(ErrorCodes.SYSTEM_PROMPT_LEAK, "Request blocked by safety policy."),
          sse.event(SseEvents.DONE, Map.of("reason", "failed")));
    }

    String continuation = UUID.randomUUID().toString();
    String redactedInput = redaction.redact(req.input());

    boolean useGraphEngine =
        req.mode() == ConversationMode.AGENT
            && (req.policy() == null || !"legacy".equals(req.policy().engine()));

    List<ActivatedSkill> activated;
    try {
      // Graph engine activates Skills per node; chat/legacy still use full router upfront.
      activated = useGraphEngine ? List.of() : skillRouter.route(req).skills();
    } catch (CodePilotException ex) {
      return Flux.just(
          sse.error(ex.code(), ex.getMessage()),
          sse.event(SseEvents.DONE, Map.of("reason", "failed")));
    }

    String toolsSchemaJson = toolSchemas.renderSchema(req.tools());
    PromptOrchestrator.Assembled assembled =
        orchestrator.assembleForRequest(req, activated, toolsSchemaJson);
    if (req.policy() != null && Boolean.TRUE.equals(req.policy().maxMode())) {
      log.info("Max mode requested: thinkingMode={}, maxOutputTokens={}",
          req.policy().thinkingMode(), req.policy().maxOutputTokens());
    }
    ContextBudgeter.Result shape = budgeter.shape(req, assembled.systemText());

    var headEvents = new java.util.ArrayList<ServerSentEvent<String>>();
    headEvents.add(
        sse.event(
            "model.requested",
            Map.of(
                "modelId", req.modelId() != null ? req.modelId() : "default",
                "thinkingMode",
                    req.policy() != null && req.policy().thinkingMode() != null
                        ? req.policy().thinkingMode()
                        : "",
                "maxOutputTokens",
                    req.policy() != null && req.policy().maxOutputTokens() != null
                        ? req.policy().maxOutputTokens()
                        : 0,
                "maxMode", req.policy() != null && Boolean.TRUE.equals(req.policy().maxMode()))));
    if (!useGraphEngine && !activated.isEmpty()) {
      headEvents.add(
          sse.event(
              SseEvents.SKILLS_ACTIVATED,
              Map.of(
                  "items",
                  activated.stream()
                      .map(
                          a ->
                              Map.of(
                                  "id", a.id(),
                                  "version", a.version(),
                                  "source", a.source(),
                                  "scope", a.scope(),
                                  "priority", a.priority(),
                                  "tokens", a.tokens()))
                      .toList())));
    }
    Flux<ServerSentEvent<String>> head = Flux.fromIterable(headEvents);

    // Resolve the ChatClient based on modelId and modelSource (model group / system model / user's custom model)
    log.info("ConversationService resolving model: modelId={}, modelSource={}, userId={}",
        req.modelId(), req.modelSource(), userId);
    ChatClientFactory.ResolvedClient resolved = chatClientFactory.resolve(req.modelId(), req.modelSource(), userId);
    ChatClient resolvedClient = resolved.chatClient();

    // ── Agent mode: always use Graph engine ──
    // Graph engine handles planning, generate→verify→repair loop, gather, etc.
    // Legacy AgentLoop is kept only when explicitly requested via policy.engine=legacy
    if (req.mode() == ConversationMode.AGENT) {
      boolean useLegacy = !useGraphEngine;
      Flux<ServerSentEvent<String>> agentBody;
      if (useLegacy) {
        // Legacy loop: one acquire/release for the whole agent run
        resolved.startRequest();
        AgentLoop loop = new AgentLoop(resolvedClient, parser, bus, stopBus, mapper, sse, serverToolExecutor);
        agentBody = loop.run(req, assembled.systemText(), redactedInput);
      } else {
        // Graph engine tracks each LLM call via GraphLlmHelper + ResolvedClient
        String resumeToken = resolveContinuationToken(req);
        if (shouldResumeFromCheckpoint(req, resumeToken)) {
          log.info(
              "ConversationService.run: redirecting to graph resume, token={}, sessionId={}, intent={}",
              resumeToken,
              req.sessionId(),
              req.intent());
          agentBody = graphEngine.resume(withContinuationToken(req, resumeToken), userId);
        } else {
          agentBody = graphEngine.run(req, userId);
        }
      }
      // ★ Agent engines (both Graph and Legacy) emit their own done(final) events.
      // Do NOT append an extra done here — it causes duplicate done(final) events
      // which lead to duplicate message persistence and split assistant replies in the UI.
      Flux<ServerSentEvent<String>> tracked =
          useLegacy
              ? head.concatWith(agentBody)
                  .doOnComplete(() -> safeEndRequest(resolved, true, 0))
                  .doOnError(e -> safeEndRequest(resolved, false, 0))
              : head.concatWith(agentBody);
      return trackSession(req.sessionId(), useLegacy ? "legacy" : "graph", tracked);
    }

    // Chat mode: single streaming turn — track request lifecycle for load balancing
    resolved.startRequest();

    // chat mode: single streaming turn.
    // Apply context budget digest if available (e.g., when history is too long)
    String chatInput = redactedInput;
    if (shape.localDigest() != null) {
      chatInput = shape.localDigest() + "\n\n" + redactedInput;
    }

    // Auto-trigger digest compression when context exceeds threshold
    // (01-§4.4: context budget signals compact → auto-append compact instruction)
    if (shape.needCompact() && assembled.systemText() != null) {
      // Compact instruction will be appended by PromptOrchestrator
      log.info("Auto-triggering digest compression (needCompact flag set)");
    }

    // ★ Build conversation history as multi-turn messages for LLM context
    // This ensures the LLM has access to previous conversation turns
    java.util.List<org.springframework.ai.chat.messages.Message> chatHistory =
        new java.util.ArrayList<>();
    if (req.contexts() != null && req.contexts().recent() != null) {
      for (var recentMsg : req.contexts().recent()) {
        String role = recentMsg.role();
        String content = recentMsg.content() != null ? recentMsg.content() : "";
        if (content.isBlank()) continue;
        if ("user".equals(role)) {
          chatHistory.add(new org.springframework.ai.chat.messages.UserMessage(content));
        } else if ("assistant".equals(role)) {
          chatHistory.add(new org.springframework.ai.chat.messages.AssistantMessage(content));
        }
      }
    }

    // Build user prompt with optional multi-modal content (01-§3.23)
    // If request has images, inject as multi-modal content
    final String finalChatInput = chatInput;
    boolean hasAttachments = req.images() != null && !req.images().isEmpty();

    Flux<ServerSentEvent<String>> body;
    if (hasAttachments) {
      // Multi-modal: build content with text + image parts
      var mediaList = req.images().stream()
          .filter(img -> img.mimeType() != null && img.mimeType().startsWith("image/"))
          .map(img -> new org.springframework.ai.content.Media(
              org.springframework.util.MimeTypeUtils.parseMimeType(img.mimeType()),
              java.net.URI.create(toDataUri(img))))
          .toList();
      
      var userMessage = org.springframework.ai.chat.messages.UserMessage.builder()
          .text(finalChatInput)
          .media(mediaList)
          .build();
      // ★ Include history messages before the current user message
      var allMessages = new java.util.ArrayList<org.springframework.ai.chat.messages.Message>(chatHistory);
      allMessages.add(userMessage);
      var userPrompt = org.springframework.ai.chat.prompt.Prompt.builder()
          .messages(allMessages)
          .build();

      var spec = resolvedClient.prompt(userPrompt).system(assembled.systemText());
      OpenAiChatOptions opts = requestOptions(req);
      if (opts != null) spec = spec.options(opts);
      body = spec.stream()
          .chatResponse()
          .map(ConversationService::deltaFromChatResponse)
          .filter(s -> !s.isBlank())
          .map(text -> sse.event(SseEvents.DELTA, Map.of("text", text)))
          .onErrorResume(
              ex -> {
                logLlmStreamError(ex);
                safeEndRequest(resolved, false, 0);
                return Flux.just(sse.error(ErrorCodes.UPSTREAM_MODEL, friendlyLlmErrorMessage(ex)));
              });
    } else {
      // Text-only mode — ★ include history messages as multi-turn context
      if (!chatHistory.isEmpty()) {
        var allMessages = new java.util.ArrayList<org.springframework.ai.chat.messages.Message>(chatHistory);
        allMessages.add(new org.springframework.ai.chat.messages.UserMessage(finalChatInput));
        var prompt = org.springframework.ai.chat.prompt.Prompt.builder()
            .messages(allMessages)
            .build();
        var spec = resolvedClient.prompt(prompt).system(assembled.systemText());
        OpenAiChatOptions opts = requestOptions(req);
        if (opts != null) spec = spec.options(opts);
        body = spec.stream()
            .chatResponse()
            .map(ConversationService::deltaFromChatResponse)
            .filter(s -> !s.isBlank())
            .map(text -> sse.event(SseEvents.DELTA, Map.of("text", text)))
            .onErrorResume(
                ex -> {
                  logLlmStreamError(ex);
                  safeEndRequest(resolved, false, 0);
                  return Flux.just(sse.error(ErrorCodes.UPSTREAM_MODEL, friendlyLlmErrorMessage(ex)));
                });
      } else {
        // No history — standard single-turn path
        var spec = resolvedClient.prompt().system(assembled.systemText()).user(finalChatInput);
        OpenAiChatOptions opts = requestOptions(req);
        if (opts != null) spec = spec.options(opts);
        body = spec.stream()
            .chatResponse()
            .map(ConversationService::deltaFromChatResponse)
            .filter(s -> !s.isBlank())
            .map(text -> sse.event(SseEvents.DELTA, Map.of("text", text)))
            .onErrorResume(
                ex -> {
                  logLlmStreamError(ex);
                  safeEndRequest(resolved, false, 0);
                  return Flux.just(sse.error(ErrorCodes.UPSTREAM_MODEL, friendlyLlmErrorMessage(ex)));
                });
      }
    }


    return trackSession(
        req.sessionId(),
        "chat",
        head.concatWith(body)
            .doOnComplete(() -> safeEndRequest(resolved, true, 0))
            .concatWith(
                Flux.just(
                    sse.event(
                        SseEvents.DONE,
                        Map.of("reason", "final", "continuationToken", continuation)))));
  }

  /**
   * Resumes a previously interrupted graph execution from a checkpoint.
   *
   * <p>If the request has a {@code continuationToken}, delegates to
   * {@link GraphEngineService#resume} which loads the checkpoint from Redis
   * and continues execution from the interrupt point.
   *
   * <p>If no continuationToken, falls back to a standard {@link #run} (backward compat).
   */
  public Flux<ServerSentEvent<String>> resume(ConversationRunRequest req, String userId) {
    String resumeToken = resolveContinuationToken(req);
    // If this is a graph resume request with continuationToken, use the checkpoint-based resume
    if (req.mode() == ConversationMode.AGENT && resumeToken != null && !resumeToken.isBlank()) {
      log.info("ConversationService.resume: resuming from checkpoint, token={}, sessionId={}",
          resumeToken, req.sessionId());

      // ★ Emit model.requested head event (same as run() — the client expects this
      // event at the start of every SSE stream to initialize the UI state).
      var headEvents = new java.util.ArrayList<ServerSentEvent<String>>();
      headEvents.add(
          sse.event(
              "model.requested",
              Map.of(
                  "modelId", req.modelId() != null ? req.modelId() : "default",
                  "thinkingMode",
                      req.policy() != null && req.policy().thinkingMode() != null
                          ? req.policy().thinkingMode()
                          : "",
                  "maxOutputTokens",
                      req.policy() != null && req.policy().maxOutputTokens() != null
                          ? req.policy().maxOutputTokens()
                          : 0,
                  "maxMode", req.policy() != null && Boolean.TRUE.equals(req.policy().maxMode()))));
      Flux<ServerSentEvent<String>> head = Flux.fromIterable(headEvents);

      return trackSession(
          req.sessionId(),
          "graph-resume",
          head.concatWith(graphEngine.resume(withContinuationToken(req, resumeToken), userId)));
    }
    // Fallback: no checkpoint, just do a normal run
    return run(req, userId);
  }

  /**
   * Resolves the checkpoint token from the request or embedded graphState snapshot.
   * The plugin may send the token only inside {@code graphState} when the user replies
   * in the main chat input instead of the structured needs_input card.
   */
  public static String resolveContinuationToken(ConversationRunRequest req) {
    if (req.continuationToken() != null && !req.continuationToken().isBlank()) {
      return req.continuationToken();
    }
    if (req.graphState() == null) {
      return null;
    }
    Object top = req.graphState().get("continuationToken");
    if (top instanceof String s && !s.isBlank()) {
      return s;
    }
    Object awaiting = req.graphState().get("awaiting");
    if (awaiting instanceof Map<?, ?> awaitingMap) {
      Object nested = awaitingMap.get("continuationToken");
      if (nested instanceof String s && !s.isBlank()) {
        return s;
      }
    }
    return null;
  }

  /** True when the client is answering an askUser interrupt and should reload the checkpoint. */
  public static boolean shouldResumeFromCheckpoint(ConversationRunRequest req, String token) {
    if (token == null || token.isBlank() || req.mode() != ConversationMode.AGENT) {
      return false;
    }
    return req.intent() == ConversationRunRequest.Intent.ANSWER
        || req.intent() == ConversationRunRequest.Intent.CONTINUE;
  }

  static ConversationRunRequest withContinuationToken(ConversationRunRequest req, String token) {
    if (token.equals(req.continuationToken())) {
      return req;
    }
    return new ConversationRunRequest(
        req.sessionId(),
        req.mode(),
        req.modelId(),
        req.modelSource(),
        req.input(),
        req.intent(),
        token,
        req.answers(),
        req.taskLedger(),
        req.lastPlanDigest(),
        req.lastAssistantTurnSummary(),
        req.sessionDigest(),
        req.contexts(),
        req.tools(),
        req.completedToolCallsTail(),
        req.earlierToolCallsCount(),
        req.projectRootHash(),
        req.userSkills(),
        req.userSkillRefs(),
        req.userSkillBodies(),
        req.userMcps(),
        req.mcpTools(),
        req.userPlanEdits(),
        req.options(),
        req.policy(),
        req.skills(),
        req.projectRules(),
        req.images(),
        req.graphState(),
        req.projectMeta());
  }

  private static String deltaFromChatResponse(ChatResponse r) {
    if (r == null || r.getResult() == null || r.getResult().getOutput() == null) return "";
    String text = r.getResult().getOutput().getText();
    return text != null ? text : "";
  }

  private static String toDataUri(ConversationRunRequest.Image img) {
    String data = img.data() != null ? img.data().trim() : "";
    if (data.startsWith("data:")) return data;
    return "data:" + img.mimeType() + ";base64," + data;
  }

  private static OpenAiChatOptions requestOptions(ConversationRunRequest req) {
    return PolicyChatOptions.fromPolicy(req.policy(), req.modelId());
  }

  /**
   * Logs LLM stream errors with appropriate detail level.
   * For 4xx client errors, logs the response body to help diagnose parameter issues.
   */
  private void logLlmStreamError(Throwable ex) {
    if (ex instanceof org.springframework.web.reactive.function.client.WebClientResponseException wcr) {
      int status = wcr.getStatusCode().value();
      if (status >= 400 && status < 500) {
        log.warn("LLM stream error: HTTP {}, response body={}", status,
            abbreviateForLog(wcr.getResponseBodyAsString(), 500));
      } else {
        log.warn("LLM stream error: HTTP {}", status, ex);
      }
    } else {
      log.warn("LLM stream error", ex);
    }
  }

  /**
   * Returns a user-friendly error message based on the LLM error type.
   * 4xx client errors (e.g. 400 Bad Request) usually indicate parameter issues.
   * 5xx server errors and network errors indicate transient upstream issues.
   */
  private static String friendlyLlmErrorMessage(Throwable ex) {
    if (ex instanceof org.springframework.web.reactive.function.client.WebClientResponseException wcr) {
      int status = wcr.getStatusCode().value();
      if (status == 400) {
        return "模型请求参数异常，请检查模型配置后重试。";
      }
      if (status == 401 || status == 403) {
        return "模型认证失败，请检查API Key配置。";
      }
      if (status == 404) {
        return "请求的模型不存在，请检查模型配置。";
      }
      if (status == 429) {
        return "模型请求过于频繁，请稍后重试。";
      }
      if (status >= 400 && status < 500) {
        return "模型请求被拒绝，请检查模型配置后重试。";
      }
    }
    return "上游模型服务异常，请稍后重试。";
  }

  private static String abbreviateForLog(String s, int maxLen) {
    if (s == null) return "null";
    return s.length() <= maxLen ? s : s.substring(0, maxLen) + "...[truncated]";
  }

  /**
   * Safely calls {@link ChatClientFactory.ResolvedClient#endRequest(boolean, int)}
   * swallowing any Redis / infrastructure exceptions so the reactive pipeline is never broken.
   */
  private void safeEndRequest(ChatClientFactory.ResolvedClient resolved, boolean success, int tokensUsed) {
    try {
      resolved.endRequest(success, tokensUsed);
    } catch (Exception e) {
      log.warn("Failed to end request (success={}, tokensUsed={}): {}", success, tokensUsed, e.getMessage());
    }
  }
}