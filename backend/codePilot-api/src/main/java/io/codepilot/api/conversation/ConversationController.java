package io.codepilot.api.conversation;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.agent.distill.DistillService;
import io.codepilot.core.agent.dream.DreamService;
import io.codepilot.core.agent.workflow.WorkflowService;
import io.codepilot.core.run.ConversationRunAdmissionService;
import io.codepilot.core.run.ConversationRunAdmissionService.AdmissionStatus;
import io.codepilot.core.session.RunRequest;
import io.codepilot.core.session.SessionService;
import io.codepilot.core.session.StreamEvent;
import io.codepilot.core.skill.SkillService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

/**
 * Conversation API — all endpoints under /v1/conversation.
 *
 * <p>This controller bridges the plugin's SSE conversation protocol with the new
 * {@link SessionService}-based architecture. It replaces the old graph-engine
 * controllers (ConversationRunController, ResumeController, StopController, etc.)
 * with a unified, simpler design.
 */
@Tag(name = "conversation", description = "Agent conversation SSE endpoints")
@RestController
@RequestMapping(value = "/v1/conversation")
public class ConversationController {

  private static final Logger log = LoggerFactory.getLogger(ConversationController.class);

  private final SessionService sessionService;
  private final ConversationRunAdmissionService admissionService;
  private final DreamService dreamService;
  private final DistillService distillService;
  private final WorkflowService workflowService;
  private final SkillService skillService;
  private final ObjectMapper mapper;

  public ConversationController(
      SessionService sessionService,
      ConversationRunAdmissionService admissionService,
      DreamService dreamService,
      DistillService distillService,
      WorkflowService workflowService,
      SkillService skillService,
      ObjectMapper mapper) {
    this.sessionService = sessionService;
    this.admissionService = admissionService;
    this.dreamService = dreamService;
    this.distillService = distillService;
    this.workflowService = workflowService;
    this.skillService = skillService;
    this.mapper = mapper;
  }

  // ── Admission ──────────────────────────────────────────────────────────

  @Operation(summary = "Probe server admission capacity before starting a run")
  @GetMapping(value = "/runs/admission", produces = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> admission(
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    AdmissionStatus status = admissionService.status(userId).block();
    if (status == null) {
      return ApiResponse.ok(Map.of("admit", true, "retryAfterSec", 0));
    }
    return ApiResponse.ok(status.toMap());
  }

  // ── Run (SSE) ──────────────────────────────────────────────────────────

  @Operation(summary = "Start a new agent run via SSE")
  @PostMapping(value = "/run", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> run(
      @RequestBody @Valid RunRequest request,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    log.info("Conversation run: sessionId={} intent={} user={}",
        request.sessionId(), request.intent(), userId);
    return sessionService.run(request, userId).map(this::toClientSse);
  }

  // ── Resume (SSE) ──────────────────────────────────────────────────────

  @Operation(summary = "Resume an existing agent run via SSE")
  @PostMapping(value = "/resume", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> resume(
      @RequestBody @Valid RunRequest request,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    // Resume is essentially a run with CONTINUE intent
    RunRequest resumeRequest = new RunRequest(
        request.sessionId(),
        request.input() != null ? request.input() : "(continue)",
        request.modelId(),
        request.modelSource(),
        RunRequest.Intent.CONTINUE,
        request.continuationToken(),
        request.goalCondition(),
        request.answers(),
        request.contexts(),
        request.tools(),
        request.mcpTools(),
        request.projectMeta(),
        request.workspaceRoot(),
        request.osHint(),
        request.projectRootHash(),
        request.projectRules(),
        request.images(),
        request.options(),
        request.mode(),
        request.skillDirs(),
        request.permissionOverrides(),
        request.parentSessionId(),
        request.modelLanguage(),
        request.maxMode(),
        request.maxModeSamples());
    log.info("Conversation resume: sessionId={} user={}", request.sessionId(), userId);
    return sessionService.run(resumeRequest, userId).map(this::toClientSse);
  }

  // ── Stop ───────────────────────────────────────────────────────────────

  @Operation(summary = "Stop a running conversation session")
  @PostMapping(value = "/stop", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, String>> stop(@RequestBody Map<String, String> body) {
    String sessionId = body.get("sessionId");
    if (sessionId == null || sessionId.isBlank()) {
      return ApiResponse.of(40001, "sessionId is required");
    }
    sessionService.stop(sessionId);
    log.info("Stop requested for session {}", sessionId);
    return ApiResponse.ok(Map.of("status", "stopping", "sessionId", sessionId));
  }

  // ── Tool Result ────────────────────────────────────────────────────────

  @Operation(summary = "Submit tool execution result back to the agent")
  @PostMapping(value = "/tool-result", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, String>> toolResult(@RequestBody Map<String, Object> body) {
    String sessionId = (String) body.get("sessionId");
    String toolCallId = (String) body.get("toolCallId");
    Boolean ok = (Boolean) body.get("ok");
    Object result = body.get("result");

    if (sessionId == null || toolCallId == null) {
      return ApiResponse.of(40001, "sessionId and toolCallId are required");
    }

    // Distinguish between permission responses and tool execution results:
    // - Permission response: ok=true/false, result=null, no errorCode/errorMessage
    // - Tool execution result: may have result, errorCode, or errorMessage
    // When a tool is refused (unsupported/failed), ok=false with errorCode or errorMessage set —
    // this must be routed to onToolResult, not respondPermission.
    if (ok != null) {
      boolean approved = ok;
      String errorCode = body.get("errorCode") instanceof String ? (String) body.get("errorCode") : null;
      String errorMessage = body.get("errorMessage") instanceof String ? (String) body.get("errorMessage") : null;
      boolean hasExecMetadata = result != null || errorCode != null || errorMessage != null;
      if (hasExecMetadata) {
        // Tool execution completed (success or failure with result/error info)
        String resultStr;
        if (result != null) {
          resultStr = result instanceof String ? (String) result : result.toString();
        } else if (errorMessage != null) {
          resultStr = errorMessage;
        } else if (errorCode != null) {
          resultStr = "[" + errorCode + "]";
        } else {
          resultStr = "";
        }
        // Detect user_skip errorCode and append it to the result string so the
        // AgentLoop can differentiate "user skipped" (should not retry) from
        // "user denied" (can try alternative approach).
        boolean userSkipped = "user_skip".equals(errorCode);
        sessionService.onToolResult(sessionId, toolCallId, approved, resultStr, userSkipped);
        log.info("Tool result received from plugin: session={} toolCallId={} ok={} errorCode={} userSkipped={}",
            sessionId, toolCallId, ok, errorCode, userSkipped);
      } else {
        // Pure permission response (approve/deny without execution)
        sessionService.respondPermission(sessionId, toolCallId, approved);
        log.info("Permission response: session={} toolCallId={} approved={}", sessionId, toolCallId, ok);
      }
    } else {
      log.info("Tool result received: session={} toolCallId={}", sessionId, toolCallId);
    }

    return ApiResponse.ok(Map.of("status", "received", "toolCallId", toolCallId));
  }

  // ── Run Status ─────────────────────────────────────────────────────────

  @Operation(summary = "Get the status of a specific run")
  @GetMapping(value = "/runs/{runId}/status", produces = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> runStatus(@PathVariable String runId) {
    return ApiResponse.ok(sessionService.runStatus(runId));
  }

  // ── Run Stream (SSE) ──────────────────────────────────────────────────

  @Operation(summary = "Attach to a durable run event stream (replay after a sequence number)")
  @GetMapping(value = "/runs/{runId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> runStream(
      @PathVariable String runId,
      @RequestParam(value = "afterSeq", defaultValue = "0") int afterSeq) {
    log.info("Durable replay: run={} afterSeq={}", runId, afterSeq);
    return sessionService.replay(runId, afterSeq).map(this::toClientSse);
  }

  // ── Plan Data ──────────────────────────────────────────────────────────

  @Operation(summary = "Submit plan data for display")
  @PostMapping(value = "/plan-data", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, String>> planData(@RequestBody Map<String, Object> body) {
    // Plan data is now managed internally by the AgentLoop
    return ApiResponse.ok(Map.of("status", "received"));
  }

  // ── Dream & Distill ──────────────────────────────────────────────────

  @Operation(summary = "Trigger dream subagent to extract persistent knowledge")
  @PostMapping(value = "/dream", consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> dream(
      @RequestBody Map<String, Object> body,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    String resolvedUser = (String) body.getOrDefault("userId", userId);
    String projectId = (String) body.getOrDefault("projectId", "default");
    log.info("Dream triggered: user={} project={}", resolvedUser, projectId);
    return dreamService.dream(resolvedUser, projectId).map(this::formatStreamEvent);
  }

  @Operation(summary = "Trigger distill subagent to discover reusable skills")
  @PostMapping(value = "/distill", consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> distill(
      @RequestBody Map<String, Object> body,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    String resolvedUser = (String) body.getOrDefault("userId", userId);
    String projectId = (String) body.getOrDefault("projectId", "default");
    log.info("Distill triggered: user={} project={}", resolvedUser, projectId);
    return distillService.distill(resolvedUser, projectId).map(this::formatStreamEvent);
  }

  // ── Fork ────────────────────────────────────────────────────────────────

  @Operation(summary = "Fork a conversation from a specific message index")
  @PostMapping(value = "/fork", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> fork(
      @RequestBody Map<String, Object> body,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    String parentSessionId = (String) body.get("sessionId");
    int forkIndex = body.get("forkIndex") instanceof Number ? ((Number) body.get("forkIndex")).intValue() : -1;
    String forkModeStr = (String) body.getOrDefault("forkMode", "index");
    String forkDesc = (String) body.getOrDefault("description", "Fork of " + parentSessionId);

    log.info("Fork requested: parent={} index={} user={}", parentSessionId, forkIndex, userId);

    return sessionService.fork(parentSessionId, forkIndex, forkModeStr, forkDesc, userId)
        .map(this::toClientSse);
  }

  @Operation(summary = "Fork a batch of conversations at once and stream all runs (best-of-N style)")
  @PostMapping(value = "/fork/batch", consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> forkBatch(
      @RequestBody Map<String, Object> body,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    String parentSessionId = (String) body.get("sessionId");
    int forkIndex = body.get("forkIndex") instanceof Number ? ((Number) body.get("forkIndex")).intValue() : -1;
    String forkMode = (String) body.getOrDefault("forkMode", "index");

    List<String> descriptions = new java.util.ArrayList<>();
    Object descs = body.get("descriptions");
    if (descs instanceof List<?> list) {
      for (Object o : list) {
        if (o != null) descriptions.add(o.toString());
      }
    }
    Object items = body.get("items");
    if (items instanceof List<?> list) {
      for (Object o : list) {
        if (o instanceof Map<?, ?> m && m.get("description") != null) {
          descriptions.add(m.get("description").toString());
        }
      }
    }

    log.info("Fork batch: parent={} count={} user={}", parentSessionId, descriptions.size(), userId);
    return sessionService.forkBatch(parentSessionId, forkIndex, forkMode, descriptions, userId)
        .map(this::toClientSse);
  }

  // ── Dynamic Workflow ─────────────────────────────────────────────────

  @Operation(summary = "Run an LLM-generated dynamic workflow script in the sandbox")
  @PostMapping(value = "/workflow", consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.APPLICATION_JSON_VALUE)
  public reactor.core.publisher.Mono<ApiResponse<Map<String, Object>>> workflow(
      @RequestBody Map<String, Object> body,
      @RequestHeader(value = "X-User-Id", required = false, defaultValue = "dev-user") String userId) {
    String script = (String) body.get("script");
    if (script == null || script.isBlank()) {
      return reactor.core.publisher.Mono.just(ApiResponse.of(40001, "script is required"));
    }
    String sessionId = (String) body.get("sessionId");
    String goal = (String) body.getOrDefault("goal", "");
    log.info("Workflow run: user={} session={}", userId, sessionId);
    return reactor.core.publisher.Mono
        .fromCallable(() -> workflowService.run(userId, sessionId, goal, script))
        .subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic())
        .map(r -> ApiResponse.ok(Map.of(
            "workflowId", r.workflowId(),
            "status", r.status(),
            "result", r.result() != null ? r.result() : "",
            "error", r.error() != null ? r.error() : "")));
  }

  // ── Skills ────────────────────────────────────────────────────────────

  @Operation(summary = "List skills available to the agent")
  @GetMapping(value = "/skills", produces = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<List<Map<String, Object>>> skills() {
    List<Map<String, Object>> out = skillService.available(false).stream()
        .map(s -> Map.<String, Object>of(
            "name", s.name(),
            "description", s.description() != null ? s.description() : ""))
        .toList();
    return ApiResponse.ok(out);
  }

  // ── SSE Event Mapping ──────────────────────────────────────────────────

  /**
   * Map an internal {@link ServerSentEvent} onto the client-facing event protocol: rename the event
   * and compact the JSON data. The framing itself (the {@code event:}/{@code data:} lines) is done
   * exactly once by Spring's {@code ServerSentEventHttpMessageWriter}; we must NOT pre-frame the
   * payload ourselves, or the writer would wrap it again and the client's {@code data} field would
   * start with a literal {@code event:} string (breaking JSON parsing).
   */
  private ServerSentEvent<String> toClientSse(ServerSentEvent<String> sse) {
    ServerSentEvent.Builder<String> builder = ServerSentEvent.builder();
    if (sse.id() != null) {
      builder.id(sse.id());
    }
    String eventName = mapSseEventName(sse.event());
    if (eventName != null) {
      builder.event(eventName);
    }
    if (sse.data() != null) {
      builder.data(compactJson(sse.data()));
    }
    return builder.build();
  }

  /** Convert a {@link StreamEvent} (from dream/distill subagents) to a client SSE event. */
  private ServerSentEvent<String> formatStreamEvent(StreamEvent event) {
    String data;
    try {
      data = mapper.writeValueAsString(event.payload());
    } catch (Exception e) {
      data = "{}";
    }
    return toClientSse(
        ServerSentEvent.<String>builder()
            .event(event.type().name().toLowerCase())
            .data(data)
            .build());
  }

  private String mapSseEventName(String event) {
    if (event == null) return null;
    return switch (event) {
      case "text" -> "delta";
      case "thinking" -> "agent_thinking";
      case "tool_call_start" -> "tool_call";
      case "tool_call_end" -> "tool_result_ack";
      case "ask_permission" -> "needs_input";
      case "permission_result" -> "tool_result_ack";
      case "checkpoint", "checkpoint_writer" -> "graph_checkpoint";
      case "compacted" -> "graph_budget_alert";
      case "goal_evaluation" -> "self_check";
      case "error" -> "error";
      case "done" -> "done";
      // New events from v2 protocol
      case "subagent_spawn" -> "subagent_spawn";
      case "subagent_progress" -> "subagent_progress";
      case "subagent_complete" -> "subagent_complete";
      case "subagent_failed" -> "subagent_failed";
      case "fork_created" -> "fork_created";
      case "memory_update" -> "memory_update";
      case "skill_invoked" -> "skill_invoked";
      case "task_update" -> "task_update";
      default -> event;
    };
  }

  /**
   * Compact JSON to a single line for SSE data format.
   */
  private String compactJson(String json) {
    if (json == null) return "";
    try {
      // Re-serialize to ensure compact single-line form
      var node = mapper.readTree(json);
      return mapper.writeValueAsString(node);
    } catch (Exception e) {
      // Not valid JSON, return as-is
      return json.replace("\n", "\\n");
    }
  }
}
