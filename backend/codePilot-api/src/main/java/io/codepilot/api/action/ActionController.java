package io.codepilot.api.action;

import io.codepilot.core.conversation.ConversationService;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.prompt.ActionPromptLoader;
import io.codepilot.core.safety.SystemPromptLeakOutputFilter;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * One-click action endpoints. All actions use the shared {@link #runAction} method which loads
 * prompt templates from {@code classpath:/prompts/action.<name>.txt} via
 * {@link ActionPromptLoader}.
 *
 * <p>Actions that need custom Request records (e.g., commit-message, inline-completion,
 * inline-edit, bug-scan) still converge on runAction for the final ConversationRunRequest
 * assembly, ensuring consistent policy, leak-filtering, and error handling.
 */
@Tag(name = "action", description = "One-click actions (refactor, review, comment, gentest, gendoc, inline-completion, commit-message, bug-scan, inline-edit)")
@RestController
@RequestMapping(value = "/v1/actions", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public class ActionController {

  private final ConversationService service;
  private final SystemPromptLeakOutputFilter leakFilter;
  private final ActionPromptLoader promptLoader;

  public ActionController(
      ConversationService service,
      SystemPromptLeakOutputFilter leakFilter,
      ActionPromptLoader promptLoader) {
    this.service = service;
    this.leakFilter = leakFilter;
    this.promptLoader = promptLoader;
  }

  // ─── Standard actions (use ActionRequest) ─────────────────────────────

  @Operation(summary = "Refactor selection")
  @PostMapping(value = "/refactor", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> refactor(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "refactor", true, userId);
  }

  @Operation(summary = "Review code")
  @PostMapping(value = "/review", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> review(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "review", false, userId);
  }

  @Operation(summary = "Generate comments")
  @PostMapping(value = "/comment", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> comment(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "comment", false, userId);
  }

  @Operation(summary = "Generate tests")
  @PostMapping(value = "/gentest", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> gentest(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "gentest", true, userId);
  }

  @Operation(summary = "Generate documentation")
  @PostMapping(value = "/gendoc", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "gendoc", false, userId);
  }

  // ─── Custom-request actions ───────────────────────────────────────────

  @Operation(summary = "Generate git commit message from diff")
  @PostMapping(value = "/commit-message", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> commitMessage(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid CommitMessageRequest req) {
    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("diff", req.diff());
    vars.put("branchName", req.branchName() != null ? req.branchName() : "unknown");
    vars.put("recentCommits", req.recentCommits() != null ? req.recentCommits() : "");
    String input = loadPrompt("commit-message", vars);
    return runActionWithInput(req.sessionId(), req.modelId(), req.modelSource(), input, false, userId);
  }

  @Operation(summary = "Inline code completion (supports FIM mode)")
  @PostMapping(value = "/inline-completion", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> inlineCompletion(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid InlineCompletionRequest req) {

    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("language", req.language());
    vars.put("filePath", req.filePath());
    vars.put("prefix", req.prefix());
    vars.put("suffix", req.suffix());
    vars.put("fileOutline", req.fileOutline() != null ? req.fileOutline() : "");
    vars.put("maxCandidates", "3");

    String action = "fim".equalsIgnoreCase(req.mode()) ? "inline-completion-fim" : "inline-completion";
    String input;
    if ("fim".equalsIgnoreCase(req.mode()) && promptLoader.exists(action)) {
      input = loadPrompt(action, vars);
    } else if (promptLoader.exists("inline-completion")) {
      input = loadPrompt("inline-completion", vars);
    } else {
      // Fallback inline prompt when template not found
      var sb = new StringBuilder();
      sb.append("[action:inline-completion]\n");
      sb.append("Language: ").append(req.language()).append('\n');
      sb.append("File: ").append(req.filePath()).append('\n');
      if (req.fileOutline() != null) {
        sb.append("File outline:\n").append(req.fileOutline()).append('\n');
      }
      sb.append("\n[PREFIX]\n").append(req.prefix()).append('\n');
      sb.append("[SUFFIX]\n").append(req.suffix()).append('\n');
      sb.append("\nComplete the code at the cursor (between PREFIX and SUFFIX):");
      input = sb.toString();
    }
    return runActionWithInput(req.sessionId(), req.modelId(), req.modelSource(), input, false, userId);
  }

  @Operation(summary = "Bug scan — find potential bugs, vulnerabilities, and code smells")
  @PostMapping(value = "/bug-scan", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> bugScan(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid BugScanRequest req) {
    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("language", req.language());
    vars.put("filePath", req.filePath());
    vars.put("code", req.code());
    vars.put("diagnostics", req.diagnostics() != null && !req.diagnostics().isEmpty()
        ? String.join("\n", req.diagnostics()) : "");
    vars.put("userLocale", "zh-CN");
    String input = loadPrompt("bug-scan", vars);
    return runActionWithInput(req.sessionId(), req.modelId(), req.modelSource(), input, false, userId);
  }

  @Operation(summary = "Inline edit (Ctrl+K) — edit selected code with natural language instruction")
  @PostMapping(value = "/inline-edit", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> inlineEdit(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid InlineEditRequest req) {
    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("language", req.language());
    vars.put("filePath", req.filePath());
    vars.put("selection", req.selection());
    vars.put("instruction", req.instruction());
    String input = loadPrompt("inline-edit", vars);
    return runActionWithInput(req.sessionId(), req.modelId(), req.modelSource(), input, false, userId);
  }

  // ─── Core runAction method ────────────────────────────────────────────

  /**
   * Shared action execution path for standard ActionRequest-based endpoints.
   * Loads the prompt template from resources, applies template variables,
   * determines engine mode (graph for refactor/gentest), and dispatches
   * to ConversationService.
   */
  private Flux<ServerSentEvent<String>> runAction(ActionRequest req, String action, boolean useGraph, String userId) {
    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("language", req.language() != null ? req.language() : "text");
    vars.put("filePath", req.filePath() != null ? req.filePath() : "<buffer>");
    vars.put("selection", req.context());
    vars.put("userInstruction", req.instruction() != null ? req.instruction() : "");
    vars.put("testFramework", req.testFramework() != null ? req.testFramework() : "");
    vars.put("docTarget", req.docTarget() != null ? req.docTarget() : "");
    vars.put("audience", req.audience() != null ? req.audience() : "");
    vars.put("userLocale", "zh-CN");

    String input = loadPrompt(action, vars);

    var mode = useGraph ? ConversationMode.AGENT : ConversationMode.CHAT;
    var policy = useGraph
        ? new ConversationRunRequest.Policy(
            8, null, null, null, null, true, null, null, null, null,
            "graph", action,
            new ConversationRunRequest.GraphVerifyPolicy(true, true, true, null),
            new ConversationRunRequest.GraphRepairPolicy(2, List.of("compile-error", "test-fail")),
            null, true, true)
        : null;

    ConversationRunRequest runReq = new ConversationRunRequest(
        req.sessionId(), mode, req.modelId(), req.modelSource() != null ? io.codepilot.core.model.ModelSource.valueOf(req.modelSource().toUpperCase()) : null, input,
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, policy, null,
        null, null);
    return leakFilter.guard(service.run(runReq, userId));
  }

  /**
   * Shared action execution path for custom-request endpoints.
   * Uses the already-assembled input string (from prompt template + custom vars).
   */
  private Flux<ServerSentEvent<String>> runActionWithInput(
      String sessionId, String modelId, String modelSource, String input, boolean useGraph, String userId) {
    var mode = useGraph ? ConversationMode.AGENT : ConversationMode.CHAT;
    ConversationRunRequest runReq = new ConversationRunRequest(
        sessionId, mode, modelId, modelSource != null ? io.codepilot.core.model.ModelSource.valueOf(modelSource.toUpperCase()) : null, input,
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, null, null,
        null, null);
    return leakFilter.guard(service.run(runReq, userId));
  }

  /**
   * Load a prompt template from resources/prompts/action.<name>.txt,
   * substitute variables, and return the resolved prompt.
   * Falls back to a simple [action:<name>] prefix if the template is missing.
   */
  private String loadPrompt(String action, Map<String, String> vars) {
    if (promptLoader.exists(action)) {
      return promptLoader.load(action, vars);
    }
    // Fallback: use a simple prefix format
    var sb = new StringBuilder();
    sb.append("[action:").append(action).append("]\n");
    for (var entry : vars.entrySet()) {
      if (entry.getValue() != null && !entry.getValue().isEmpty()) {
        sb.append(entry.getKey()).append(": ").append(entry.getValue()).append('\n');
      }
    }
    return sb.toString();
  }

  // ─── Request records ──────────────────────────────────────────────────

  public record ActionRequest(
      @NotBlank String sessionId,
      String modelId,
      String modelSource,
      @NotBlank String context,
      String instruction,
      String language,
      String filePath,
      String testFramework,
      String docTarget,
      String audience) {}

  public record CommitMessageRequest(
      @NotBlank String sessionId,
      String modelId,
      String modelSource,
      @NotBlank String diff,
      String branchName,
      String recentCommits) {}

  public record InlineCompletionRequest(
      @NotBlank String sessionId,
      String modelId,
      String modelSource,
      @NotBlank String prefix,
      @NotBlank String suffix,
      @NotBlank String language,
      @NotBlank String filePath,
      String fileOutline,
      Integer maxTokens,
      String mode) {}

  public record BugScanRequest(
      @NotBlank String sessionId,
      String modelId,
      String modelSource,
      @NotBlank String code,
      @NotBlank String language,
      @NotBlank String filePath,
      List<String> diagnostics) {}

  public record InlineEditRequest(
      @NotBlank String sessionId,
      String modelId,
      String modelSource,
      @NotBlank String selection,
      @NotBlank String instruction,
      @NotBlank String language,
      @NotBlank String filePath) {}
}