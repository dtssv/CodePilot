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
      GraphEngineService graphEngine) {
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
  }

  public Flux<ServerSentEvent<String>> run(ConversationRunRequest req) {
    SystemPromptLeakDetector.Verdict verdict = leakDetector.detect(req.input());
    if (verdict.blocked()) {
      audit.leakDetectedPre(null, verdict.matchedRule());
      return Flux.just(
          sse.error(ErrorCodes.SYSTEM_PROMPT_LEAK, "Request blocked by safety policy."),
          sse.event(SseEvents.DONE, Map.of("reason", "failed")));
    }

    String continuation = UUID.randomUUID().toString();
    String redactedInput = redaction.redact(req.input());

    List<ActivatedSkill> activated;
    try {
      activated = skillRouter.route(req).skills();
    } catch (CodePilotException ex) {
      return Flux.just(
          sse.error(ex.code(), ex.getMessage()),
          sse.event(SseEvents.DONE, Map.of("reason", "failed")));
    }

    String toolsSchemaJson = toolSchemas.renderSchema(req.tools());
    PromptOrchestrator.Assembled assembled =
        orchestrator.assembleForRequest(req, activated, toolsSchemaJson);
    ContextBudgeter.Result shape = budgeter.shape(req, assembled.systemText());

    Flux<ServerSentEvent<String>> head =
        Flux.just(
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

    // Resolve the ChatClient based on modelId (system model or user's custom model)
    ChatClient resolvedClient = chatClientFactory.resolve(req.modelId());

    // ── Graph engine routing ──
    if (req.policy() != null && "graph".equals(req.policy().engine())) {
      return head.concatWith(graphEngine.run(req));
    }

    if (req.mode() == ConversationMode.AGENT) {
      AgentLoop loop = new AgentLoop(resolvedClient, parser, bus, stopBus, mapper, sse, serverToolExecutor);
      return head.concatWith(loop.run(req, assembled.systemText(), redactedInput));
    }

    // chat mode: single streaming turn.
    // Apply context budget digest if available (e.g., when history is too long)
    String chatInput = redactedInput;
    if (shape.localDigest() != null) {
      chatInput = shape.localDigest() + "\n\n" + redactedInput;
    }
    final String finalChatInput = chatInput;

    Flux<ServerSentEvent<String>> body =
        resolvedClient
            .prompt()
            .system(assembled.systemText())
            .user(finalChatInput)
            .stream()
            .chatResponse()
            .map(ConversationService::deltaFromChatResponse)
            .filter(s -> !s.isBlank())
            .map(text -> sse.event(SseEvents.DELTA, Map.of("text", text)))
            .onErrorResume(
                ex -> {
                  log.warn("LLM stream error", ex);
                  return Flux.just(sse.error(ErrorCodes.UPSTREAM_MODEL, "Upstream error"));
                });

    return head.concatWith(body)
        .concatWith(
            Flux.just(
                sse.event(
                    SseEvents.DONE, Map.of("reason", "final", "continuationToken", continuation))));
  }

  private static String deltaFromChatResponse(ChatResponse r) {
    if (r == null || r.getResult() == null || r.getResult().getOutput() == null) return "";
    return r.getResult().getOutput().getContent();
  }
}