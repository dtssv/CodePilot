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
import java.util.Locale;
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
    return runAction(req, "refactor", req.useGraph() == null || req.useGraph(), userId);
  }

  @Operation(summary = "Review code")
  @PostMapping(value = "/review", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> review(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "review", req.useGraph() == null || req.useGraph(), userId);
  }

  @Operation(summary = "Generate comments")
  @PostMapping(value = "/comment", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> comment(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    // P2 audit fix — let callers opt OUT of graph mode for one-shot CHAT
    // comment generation (graph mode is overkill for a single file).
    boolean useGraph = Boolean.TRUE.equals(req.useGraph());
    return runAction(req, "comment", useGraph, userId);
  }

  @Operation(summary = "Generate tests")
  @PostMapping(value = "/gentest", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> gentest(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    return runAction(req, "gentest", req.useGraph() == null || req.useGraph(), userId);
  }

  @Operation(summary = "Generate documentation")
  @PostMapping(value = "/gendoc", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ActionRequest req) {
    boolean useGraph = Boolean.TRUE.equals(req.useGraph());
    return runAction(req, "gendoc", useGraph, userId);
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
    // P0 audit fix — extended context fields. All optional; we pass empty
    // string when the client did not supply them so prompt placeholders render
    // cleanly without `null` leaking into the LLM input.
    vars.put("fileOutline", emptyIfNull(req.fileOutline()));
    vars.put("prefixContext", emptyIfNull(req.prefixContext()));
    vars.put("suffixContext", emptyIfNull(req.suffixContext()));
    vars.put("cursorOffset", req.cursorOffset() != null ? req.cursorOffset().toString() : "-1");
    vars.put("diagnostics",
        req.diagnostics() != null && !req.diagnostics().isEmpty()
            ? String.join("\n", req.diagnostics()) : "");
    vars.put("userLocale", "zh-CN");
    // If the selection is empty (or only whitespace), fall back to the
    // "generate" variant which produces fresh code from scratch instead of
    // replacing existing code.
    boolean empty = req.selection() == null || req.selection().trim().isEmpty();
    String action = empty && promptLoader.exists("inline-edit-generate")
        ? "inline-edit-generate" : "inline-edit";
    String input = loadPrompt(action, vars);
    return runActionWithInput(req.sessionId(), req.modelId(), req.modelSource(), input, false, userId);
  }

  private static String emptyIfNull(String s) { return s == null ? "" : s; }

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
    // Plain source text only — clients MUST NOT wrap with [action] headers or fenced blocks here;
    // action.*.txt templates own the markdown structure (see docs in plugin ActionBase).
    vars.put("selection", req.context());
    vars.put("userInstruction", req.instruction() != null ? req.instruction() : "");
    String tf = req.testFramework() != null ? req.testFramework() : "";
    if ((tf.isEmpty()) && ("gentest".equals(action))) {
      tf = inferTestFramework(vars.get("language"));
    }
    vars.put("testFramework", tf);
    vars.put(
        "existingTestsOutline",
        req.existingTestsOutline() != null && !req.existingTestsOutline().isBlank()
            ? req.existingTestsOutline()
            : "(not provided — inspect repo conventions from path and sibling tests if needed)");
    vars.put("docTarget", req.docTarget() != null ? req.docTarget() : "");
    vars.put("audience", req.audience() != null ? req.audience() : "");
    vars.put("userLocale", "zh-CN");
    vars.put(
        "fileOutline",
        req.fileOutline() != null && !req.fileOutline().isBlank()
            ? req.fileOutline()
            : "(not provided — infer structure from selection and path)");
    vars.put(
        "projectInfo",
        req.projectMeta() != null && !req.projectMeta().isBlank()
            ? req.projectMeta()
            : "(not provided)");
    int startLine =
        req.startLine() != null && req.startLine() > 0 ? req.startLine() : 1;
    int endLine =
        req.endLine() != null && req.endLine() >= startLine ? req.endLine() : startLine + linesInText(req.context()) - 1;
    vars.put("startLine", Integer.toString(startLine));
    vars.put("endLine", Integer.toString(endLine));

    String input = loadPrompt(action, vars);

    var mode = useGraph ? ConversationMode.AGENT : ConversationMode.CHAT;
    var policy = useGraph
        ? new ConversationRunRequest.Policy(
            8, null, null, null, null, true, null, null, null, null,
            "graph", action,
            new ConversationRunRequest.GraphVerifyPolicy(true, true, true, null),
            new ConversationRunRequest.GraphRepairPolicy(2, List.of("compile-error", "test-fail")),
            null, true, true,
            /*bareMode*/ null, null, null, null)
        : null;

    ConversationRunRequest runReq = new ConversationRunRequest(
        req.sessionId(), mode, req.modelId(), req.modelSource() != null ? io.codepilot.core.model.ModelSource.valueOf(req.modelSource().toUpperCase()) : null, input,
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, null, null, null, policy, null,
        null, null, null, null);
    return leakFilter.guard(service.run(runReq, userId));
  }

  /**
   * Shared action execution path for custom-request endpoints. By default
   * runs in bare mode so we don't ship the large base+chat system preamble
   * on latency-sensitive endpoints (inline-edit, inline-completion,
   * commit-message, bug-scan). Pass {@code useGraph=true} to opt into the
   * full agent stack.
   */
  private Flux<ServerSentEvent<String>> runActionWithInput(
      String sessionId, String modelId, String modelSource, String input, boolean useGraph, String userId) {
    var mode = useGraph ? ConversationMode.AGENT : ConversationMode.CHAT;
    // bareMode is only meaningful for CHAT runs — graph engine builds its
    // own prompt stack and ignores the policy flag.
    var policy = useGraph ? null : new ConversationRunRequest.Policy(
        null, null, null, null, null, null, null, null, null, null,
        null, null, null, null, null, null, null,
        /*bareMode*/ Boolean.TRUE, null, null, null);
    ConversationRunRequest runReq = new ConversationRunRequest(
        sessionId, mode, modelId, modelSource != null ? io.codepilot.core.model.ModelSource.valueOf(modelSource.toUpperCase()) : null, input,
        null, null, null, null, null, null, null, null,
        List.of(), null, null, null, null, null, null, null, null, null, null, policy, null,
        null, null, null, null);
    return leakFilter.guard(service.run(runReq, userId));
  }

  /** Count lines in a {@code selection} fragment (minimum 1). */
  private static int linesInText(String selection) {
    if (selection == null || selection.isEmpty()) return 1;
    int lines = 1;
    for (int i = 0; i < selection.length(); i++) {
      if (selection.charAt(i) == '\n') lines++;
    }
    return lines;
  }

  /** Fallback when the IDE client does not send testFramework (gentest only). */
  private static String inferTestFramework(String language) {
    if (language == null || language.isBlank()) return "";
    String l = language.toLowerCase(Locale.ROOT);
    if (l.contains("kotlin")) {
      return "JUnit 5 (AssertJ optional) unless the repo clearly uses TestNG.";
    }
    if (l.contains("javascript") || l.contains("typescript") || l.contains("jsx") || l.contains("tsx")) {
      return "Vitest/Jest depending on package.json hints.";
    }
    if (l.contains("java")) {
      return "JUnit 5 (AssertJ optional) unless the repo clearly uses TestNG.";
    }
    if (l.contains("python")) {
      return "pytest (unittest if the tree only uses unittest).";
    }
    if (l.contains("go") || l.contains("golang")) {
      return "go test; testify/gomock if imports already exist.";
    }
    if (l.contains("c++")
        || l.contains("cpp")
        || "cuda".equals(l)
        || l.contains("objc")
        || "objectivec".equals(l)) {
      return "GoogleTest / Catch2 — match CMakeLists/convention.";
    }
    if (l.contains("swift")) {
      return "XCTest.";
    }
    if (l.contains("csharp") || l.contains("c#") || l.contains("vb.net") || "vb".equals(l)) {
      return "xUnit / NUnit consistent with *.csproj.";
    }
    if (l.contains("rust")) {
      return "cargo test + standard #[cfg(test)] modules.";
    }
    if (l.contains("ruby")) {
      return "RSpec/Minitest as used in the Gemfile.";
    }
    return "";
  }

  /**
   * Load a prompt template from resources/prompts/action.&lt;name&gt;.txt,
   * substitute variables, and return the resolved prompt.
   * Falls back to a simple {@code [action:name]} prefix if the template is missing.
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
      String audience,
      /**
       * Opt into graph engine mode (planning + verify + repair). Defaults to
       * the action's historical setting: refactor/review/gentest default to
       * graph=true, comment/gendoc default to graph=false unless the caller
       * sets this flag.
       */
      Boolean useGraph,
      /** 1-based start line of {@code context} within the editor file (optional). */
      Integer startLine,
      /** 1-based end line (inclusive) of {@code context} within the editor file (optional). */
      Integer endLine,
      /** Optional coarse symbol/file outline forwarded from the IDE. */
      String fileOutline,
      /** Optional workspace / project snippet (build tool, conventions). */
      String projectMeta,
      /** Optional neighbouring test file summary for gentest (IDE may omit). */
      String existingTestsOutline) {}

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

  /**
   * Inline-edit request. The first 7 fields are the original contract. The
   * trailing 5 are P0-audit additions that let the model do Cursor-grade
   * context-aware edits without breaking older clients (all optional).
   *
   * <p>Note: {@code selection} stays {@code @NotBlank} so the legacy "edit"
   * mode keeps its invariant; the "generate" mode (empty selection) goes
   * through the same record by passing a single space — the controller
   * detects the whitespace-only case and routes to the generate prompt.
   */
  public record InlineEditRequest(
      @NotBlank String sessionId,
      String modelId,
      String modelSource,
      @NotBlank String selection,
      @NotBlank String instruction,
      @NotBlank String language,
      @NotBlank String filePath,
      /** ~30 lines of code immediately before the selection (optional). */
      String prefixContext,
      /** ~30 lines of code immediately after the selection (optional). */
      String suffixContext,
      /** PSI top-level outline of the file (optional). */
      String fileOutline,
      /** Cursor offset inside the selection (0-based), or null if unknown. */
      Integer cursorOffset,
      /** Current IDE diagnostics on the file (one per line). */
      java.util.List<String> diagnostics) {}
}