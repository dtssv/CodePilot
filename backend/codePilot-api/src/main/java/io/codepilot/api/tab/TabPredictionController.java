package io.codepilot.api.tab;

import com.google.common.io.Resources;
import io.codepilot.api.fim.FimSyncCompleter;
import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ChatClientFactory.ResolvedClient;
import io.codepilot.core.model.ModelGroup;
import io.codepilot.core.model.ModelService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "tab-prediction", description = "Model-based multi-line tab predictions")
@RestController
@RequestMapping(value = "/v1/tab", produces = MediaType.APPLICATION_JSON_VALUE)
public class TabPredictionController {

  private static final Logger log = LoggerFactory.getLogger(TabPredictionController.class);

  private final ChatClientFactory clientFactory;
  private final ModelService modelService;
  private final FimSyncCompleter fimSyncCompleter;

  public TabPredictionController(
      ChatClientFactory clientFactory, ModelService modelService, FimSyncCompleter fimSyncCompleter) {
    this.clientFactory = clientFactory;
    this.modelService = modelService;
    this.fimSyncCompleter = fimSyncCompleter;
  }

  @Operation(summary = "Predict structured edits for tab completion")
  @PostMapping(value = "/predict", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> predict(@RequestBody @Valid PredictRequest req) {
    String template = loadTemplate("prompts/agent.edit-prediction.txt");
    List<Map<String, Object>> edits = new ArrayList<>(suggestEdits(req));
    String modelNote = "heuristics";
    if (edits.isEmpty() && shouldTryModel(req)) {
      List<Map<String, Object>> fimEdits = suggestWithFim(req);
      if (!fimEdits.isEmpty()) {
        edits = fimEdits;
        modelNote = "fim";
      } else {
        List<Map<String, Object>> modelEdits = suggestWithModel(req, template);
        if (!modelEdits.isEmpty()) {
          edits = modelEdits;
          modelNote = "model";
        }
      }
    }
    return ApiResponse.ok(
        Map.of(
            "promptTemplateLoaded", template != null && !template.isBlank(),
            "edits", edits,
            "source", modelNote,
            "note", edits.isEmpty() ? "No high-confidence edit inferred." : "ok"));
  }

  private boolean shouldTryModel(PredictRequest req) {
    String prefix = req.prefix() != null ? req.prefix() : "";
    return prefix.length() >= 24;
  }

  /** Native FIM-style infill via {@link FimSyncCompleter} (Codestral / StarCoder / Qwen-Coder). */
  private List<Map<String, Object>> suggestWithFim(PredictRequest req) {
    try {
      String modelId = fimSyncCompleter.pickFimCoderModel();
      if (modelId == null) return List.of();
      String prefix = req.prefix() != null ? req.prefix() : "";
      String suffix = req.suffix() != null ? req.suffix() : "";
      String completion = fimSyncCompleter.complete(modelId, prefix, suffix, 128);
      if (completion.isBlank()) return List.of();
      String newText = sanitizeCompletion(completion);
      if (newText.isBlank()) return List.of();
      return List.of(
          Map.of(
              "path", req.filePath(),
              "range",
                  Map.of(
                      "startLine", req.cursorLine(),
                      "endLine", req.cursorLine(),
                      "offset", 0),
              "newText", newText,
              "confidence", 0.74));
    } catch (Exception e) {
      log.debug("Tab FIM predict skipped: {}", e.getMessage());
      return List.of();
    }
  }

  private List<Map<String, Object>> suggestWithModel(PredictRequest req, String template) {
    try {
      String modelId = pickFastCoderModel();
      if (modelId == null) return List.of();
      ResolvedClient resolved = clientFactory.resolve(modelId, null);
      resolved.startRequest();
      try {
        String userPrompt = buildModelPrompt(req, template);
        String completion =
            resolved
                .chatClient()
                .prompt()
                .user(userPrompt)
                .call()
                .content();
        if (completion == null || completion.isBlank()) return List.of();
        String newText = sanitizeCompletion(completion);
        if (newText.isBlank()) return List.of();
        return List.of(
            Map.of(
                "path", req.filePath(),
                "range",
                    Map.of(
                        "startLine", req.cursorLine(),
                        "endLine", req.cursorLine(),
                        "offset", 0),
                "newText", newText,
                "confidence", 0.68));
      } finally {
        resolved.endRequest(true, 0);
      }
    } catch (Exception e) {
      log.debug("Tab model predict skipped: {}", e.getMessage());
      return List.of();
    }
  }

  private static String buildModelPrompt(PredictRequest req, String template) {
    String prefix = req.prefix() != null ? req.prefix() : "";
    String suffix = req.suffix() != null ? req.suffix() : "";
    String guide =
        template != null && !template.isBlank()
            ? template
            : "Predict only the text to insert at the cursor. No markdown fences or explanation.";
    return guide
        + "\n\nFile: "
        + req.filePath()
        + " ("
        + req.language()
        + ")\n--- prefix ---\n"
        + tail(prefix, 800)
        + "\n--- suffix ---\n"
        + head(suffix, 400)
        + "\n--- response (insertion only) ---\n";
  }

  private static String sanitizeCompletion(String raw) {
    String t = raw.strip();
    if (t.startsWith("```")) {
      int end = t.indexOf("```", 3);
      t = end > 0 ? t.substring(t.indexOf('\n', 0) + 1, end).strip() : t.replace("```", "").strip();
    }
    if (t.length() > 400) t = t.substring(0, 400);
    return t;
  }

  private String pickFastCoderModel() {
    var groups = modelService.listModelGroups().stream().filter(ModelGroup::enabled).toList();
    if (groups.isEmpty()) return null;
    return groups.stream()
        .filter(
            g -> {
              String m = g.model() != null ? g.model().toLowerCase() : "";
              return m.contains("mini")
                  || m.contains("haiku")
                  || m.contains("flash")
                  || m.contains("fast")
                  || m.contains("codestral");
            })
        .map(ModelGroup::model)
        .findFirst()
        .orElse(groups.getFirst().model());
  }

  private static String tail(String s, int max) {
    return s.length() <= max ? s : s.substring(s.length() - max);
  }

  private static String head(String s, int max) {
    return s.length() <= max ? s : s.substring(0, max);
  }

  /** Lightweight heuristics; plugin applies confidence threshold. */
  private static List<Map<String, Object>> suggestEdits(PredictRequest req) {
    String prefix = req.prefix() != null ? req.prefix() : "";
    String suffix = req.suffix() != null ? req.suffix() : "";
    if (prefix.endsWith("{") && !suffix.trim().startsWith("}")) {
      String indent = prefix.lines().reduce("", (a, b) -> b).replaceAll("[^ \\t].*", "");
      if (indent.length() < 4) indent = "    ";
      return List.of(
          Map.of(
              "path", req.filePath(),
              "range", Map.of("startLine", req.cursorLine(), "endLine", req.cursorLine(), "offset", 0),
              "newText", "\n" + indent + "}",
              "confidence", 0.72));
    }
    if (prefix.trim().endsWith("(") && !suffix.trim().startsWith(")")) {
      return List.of(
          Map.of(
              "path", req.filePath(),
              "range", Map.of("startLine", req.cursorLine(), "endLine", req.cursorLine(), "offset", 0),
              "newText", ")",
              "confidence", 0.55));
    }
    return List.of();
  }

  private static String loadTemplate(String resource) {
    try {
      var url = Thread.currentThread().getContextClassLoader().getResource(resource);
      return url != null ? Resources.toString(url, StandardCharsets.UTF_8) : "";
    } catch (Exception e) {
      return "";
    }
  }

  public record PredictRequest(
      @NotBlank String filePath,
      @NotBlank String language,
      String prefix,
      String suffix,
      int cursorLine,
      int cursorColumn) {}
}
