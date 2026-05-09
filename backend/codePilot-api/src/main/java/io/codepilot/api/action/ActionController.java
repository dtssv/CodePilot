package io.codepilot.api.action;

import io.codepilot.core.conversation.ConversationService;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.safety.SystemPromptLeakOutputFilter;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * One-click action endpoints (refactor, review, comment, gentest, gendoc, inline-completion,
 * commit-message). These are shortcuts that wrap /conversation/run with a fixed mode and
 * action-specific prompt assembly.
 */
@Tag(name = "action", description = "One-click actions (refactor, review, comment, gentest, gendoc, inline-completion, commit-message)")
@RestController
@RequestMapping(value = "/v1/actions", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public class ActionController {

  private final ConversationService service;
  private final SystemPromptLeakOutputFilter leakFilter;

  public ActionController(ConversationService service, SystemPromptLeakOutputFilter leakFilter) {
    this.service = service;
    this.leakFilter = leakFilter;
  }

  @Operation(summary = "Refactor selection")
  @PostMapping(value = "/refactor", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> refactor(@RequestBody @Valid ActionRequest req) {
    return runAction(req, "refactor");
  }

  @Operation(summary = "Review code")
  @PostMapping(value = "/review", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> review(@RequestBody @Valid ActionRequest req) {
    return runAction(req, "review");
  }

  @Operation(summary = "Generate comments")
  @PostMapping(value = "/comment", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> comment(@RequestBody @Valid ActionRequest req) {
    return runAction(req, "comment");
  }

  @Operation(summary = "Generate tests")
  @PostMapping(value = "/gentest", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> gentest(@RequestBody @Valid ActionRequest req) {
    return runAction(req, "gentest");
  }

  @Operation(summary = "Generate documentation")
  @PostMapping(value = "/gendoc", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(@RequestBody @Valid ActionRequest req) {
    return runAction(req, "gendoc");
  }

  @Operation(summary = "Generate git commit message from diff")
  @PostMapping(value = "/commit-message", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> commitMessage(@RequestBody @Valid CommitMessageRequest req) {
    String input = "[action:commit-message]\n"
        + "Branch: " + (req.branchName() != null ? req.branchName() : "unknown") + "\n"
        + (req.recentCommits() != null ? "Recent commits:\n" + req.recentCommits() + "\n" : "")
        + "\n```diff\n" + req.diff() + "\n```";
    ConversationRunRequest runReq = new ConversationRunRequest(
        req.sessionId(), ConversationMode.CHAT, req.modelId(), input,
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, null, null);
    return leakFilter.guard(service.run(runReq));
  }

  @Operation(summary = "Inline code completion")
  @PostMapping(value = "/inline-completion", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> inlineCompletion(
      @RequestBody @Valid InlineCompletionRequest req) {
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
    ConversationRunRequest runReq = new ConversationRunRequest(
        req.sessionId(), ConversationMode.CHAT, req.modelId(), sb.toString(),
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, null, null);
    return leakFilter.guard(service.run(runReq));
  }

  private Flux<ServerSentEvent<String>> runAction(ActionRequest req, String action) {
    // Build a ConversationRunRequest with mode=chat (actions are single-turn, no tools)
    // The action type is passed via the input prefix for PromptOrchestrator to pick the right Skill
    String input = "[action:" + action + "] " + (req.instruction() != null ? req.instruction() : "") + "\n\n" + req.context();

    // Determine engine: refactor and gentest benefit from graph (generate→verify→repair loop)
    var useGraph = "refactor".equals(action) || "gentest".equals(action);
    var mode = useGraph ? ConversationMode.AGENT : ConversationMode.CHAT;
    var policy = useGraph
        ? new ConversationRunRequest.Policy(
            8, null, null, null, null, true, null, null, null, null,
            "graph", action, // engine=graph, graphTemplate=action
            new ConversationRunRequest.GraphVerifyPolicy(true, true, true, null),
            new ConversationRunRequest.GraphRepairPolicy(2, List.of("compile-error", "test-fail")),
            null, true, true)
        : null;

    ConversationRunRequest runReq = new ConversationRunRequest(
        req.sessionId(), mode, req.modelId(), input,
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, policy, null);
    return leakFilter.guard(service.run(runReq));
  }

  public record ActionRequest(
      @NotBlank String sessionId,
      String modelId,
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
      @NotBlank String diff,
      String branchName,
      String recentCommits) {}

  public record InlineCompletionRequest(
      @NotBlank String sessionId,
      String modelId,
      @NotBlank String prefix,
      @NotBlank String suffix,
      @NotBlank String language,
      @NotBlank String filePath,
      String fileOutline,
      Integer maxTokens) {}
}