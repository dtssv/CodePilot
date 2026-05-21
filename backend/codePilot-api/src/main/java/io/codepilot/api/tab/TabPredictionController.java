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
import org.springframework.ai.openai.OpenAiChatOptions;
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
    String infillTemplate = loadTemplate("prompts/tab.infill.txt");
    List<Map<String, Object>> edits = new ArrayList<>(suggestEdits(req));
    String modelNote = "heuristics";
    boolean tryModel = edits.isEmpty() && shouldTryModel(req);
    if (tryModel) {
      List<Map<String, Object>> fimEdits = suggestWithFim(req);
      if (!fimEdits.isEmpty()) {
        edits = fimEdits;
        modelNote = "fim";
      } else {
        List<Map<String, Object>> modelEdits = suggestWithInfillModel(req, infillTemplate);
        if (!modelEdits.isEmpty()) {
          edits = modelEdits;
          modelNote = "infill";
        }
      }
    }
    String note = edits.isEmpty() ? emptyNote(req, tryModel) : "ok";
    return ApiResponse.ok(
        Map.of(
            "promptTemplateLoaded", infillTemplate != null && !infillTemplate.isBlank(),
            "edits", edits,
            "source", modelNote,
            "note", note));
  }

  private static final int TAB_MAX_INSERT_CHARS = 120;
  private static final int TAB_MAX_INSERT_LINES = 3;

  /**
   * Call FIM/LLM when the caret line has enough typed context, or the file prefix is non-trivial.
   *
   * <p>Markdown-only guard: skip doc-scale FIM when the user typed short prose on the last line of a
   * long .md file (e.g. "你好"). Code lines with {@code <<}, {@code ;}, etc. are never skipped.
   */
  private boolean shouldTryModel(PredictRequest req) {
    String prefix = req.prefix() != null ? req.prefix() : "";
    String trimmed = lastLine(prefix).strip();
    if (trimmed.length() < 2) {
      return false;
    }
    if (shouldSkipFimForShortMarkdownLine(req, prefix, trimmed)) {
      return false;
    }
    return trimmed.length() >= 6 || prefix.length() >= 24;
  }

  private static boolean shouldSkipFimForShortMarkdownLine(
      PredictRequest req, String prefix, String trimmed) {
    if (!isMarkdownLike(req.language()) || prefix.length() <= 200 || trimmed.length() >= 16) {
      return false;
    }
    return !looksLikeCodeFragment(trimmed);
  }

  private static boolean isMarkdownLike(String language) {
    if (language == null || language.isBlank()) {
      return false;
    }
    String l = language.toLowerCase();
    return l.equals("md") || l.equals("markdown") || l.contains("markdown");
  }

  /** True when the current line still looks like code (C++, Java, etc.), not plain prose. */
  private static boolean looksLikeCodeFragment(String trimmed) {
    return trimmed.contains("{")
        || trimmed.contains("}")
        || trimmed.contains("(")
        || trimmed.contains(")")
        || trimmed.contains(";")
        || trimmed.contains("<<")
        || trimmed.contains(">>")
        || trimmed.contains("=")
        || trimmed.contains("->")
        || trimmed.contains("::");
  }

  private static String lastLine(String prefix) {
    int i = prefix.lastIndexOf('\n');
    return i >= 0 ? prefix.substring(i + 1) : prefix;
  }

  /** FIM-token infill — uses any enabled model; output constrained by prompt + sanitize. */
  private List<Map<String, Object>> suggestWithFim(PredictRequest req) {
    try {
      String modelId = fimSyncCompleter.pickTabPredictModel();
      if (modelId == null) return List.of();
      String prefix = focusedPrefix(req);
      String suffix = focusedSuffix(req);
      String completion = fimSyncCompleter.complete(modelId, prefix, suffix, 64);
      if (completion.isBlank()) return List.of();
      String newText = sanitizeCompletion(completion, req.language(), req);
      if (newText.isBlank()) {
        log.debug("Tab FIM rejected completion for {}", req.filePath());
        return List.of();
      }
      return List.of(
          Map.of(
              "path", req.filePath(),
              "range",
                  Map.of("startLine", req.cursorLine(), "endLine", req.cursorLine()),
              "newText", newText,
              "confidence", 0.74));
    } catch (Exception e) {
      log.debug("Tab FIM predict skipped: {}", e.getMessage());
      return List.of();
    }
  }

  /** Plain chat infill — same enabled model, strict tab.infill.txt prompt. */
  private List<Map<String, Object>> suggestWithInfillModel(PredictRequest req, String template) {
    try {
      String modelId = fimSyncCompleter.pickTabPredictModel();
      if (modelId == null) return List.of();
      ResolvedClient resolved = clientFactory.resolve(modelId, null);
      resolved.startRequest();
      try {
        String userPrompt = buildInfillPrompt(req, template);
        OpenAiChatOptions options =
            OpenAiChatOptions.builder().temperature(0.05).maxTokens(96).build();
        String completion =
            resolved
                .chatClient()
                .prompt()
                .user(userPrompt)
                .options(options)
                .call()
                .content();
        if (completion == null || completion.isBlank()) return List.of();
        String newText = sanitizeCompletion(completion, req.language(), req);
        if (newText.isBlank()) {
          log.debug("Tab infill rejected completion for {}", req.filePath());
          return List.of();
        }
        return List.of(
            Map.of(
                "path", req.filePath(),
                "range",
                    Map.of("startLine", req.cursorLine(), "endLine", req.cursorLine()),
                "newText", newText,
                "confidence", 0.68));
      } finally {
        resolved.endRequest(true, 0);
      }
    } catch (Exception e) {
      log.debug("Tab infill predict skipped: {}", e.getMessage());
      return List.of();
    }
  }

  private static String focusedPrefix(PredictRequest req) {
    String file = tail(req.prefix() != null ? req.prefix() : "", 200);
    String linePre =
        req.currentLinePrefix() != null && !req.currentLinePrefix().isBlank()
            ? req.currentLinePrefix()
            : lastLine(req.prefix() != null ? req.prefix() : "");
    return file + "\n<<<CURSOR_LINE>>>\n" + linePre;
  }

  private static String focusedSuffix(PredictRequest req) {
    String lineSuf = req.currentLineSuffix() != null ? req.currentLineSuffix() : "";
    String file = head(req.suffix() != null ? req.suffix() : "", 120);
    return lineSuf + file;
  }

  private static String buildInfillPrompt(PredictRequest req, String template) {
    String lang = req.language() != null ? req.language() : "text";
    String linePre =
        req.currentLinePrefix() != null && !req.currentLinePrefix().isBlank()
            ? req.currentLinePrefix()
            : lastLine(req.prefix() != null ? req.prefix() : "");
    String lineSuf = req.currentLineSuffix() != null ? req.currentLineSuffix() : "";
    String guide =
        (template != null ? template : "").replace("{{language}}", lang).strip();
    if (guide.isBlank()) {
      guide =
          "Output ONLY raw code to insert at the cursor between PREFIX and SUFFIX. "
              + "No JSON. No markdown. No explanation. Max 120 characters.";
    }
    return guide
        + "\n\n[CONTEXT]\nFile: "
        + req.filePath()
        + " ("
        + lang
        + ")\nCursor: line "
        + req.cursorLine()
        + " column "
        + req.cursorColumn()
        + "\n\n--- CURRENT LINE (complete ONLY the gap at [CURSOR]) ---\n"
        + linePre
        + "[CURSOR]"
        + lineSuf
        + "\n\n--- FILE CONTEXT (prefix tail) ---\n"
        + tail(req.prefix() != null ? req.prefix() : "", 200)
        + "\n--- FILE CONTEXT (suffix head) ---\n"
        + head(req.suffix() != null ? req.suffix() : "", 120)
        + "\n\n--- INSERTION (your output, nothing else) ---\n";
  }

  private static String sanitizeCompletion(String raw, String language, PredictRequest req) {
    String t = raw.strip();
    if (looksLikeEditPredictionJson(t)) {
      return "";
    }
    if (t.startsWith("```")) {
      int end = t.indexOf("```", 3);
      t = end > 0 ? t.substring(t.indexOf('\n', 0) + 1, end).strip() : t.replace("```", "").strip();
    }
    if (t.isEmpty() || !isValidTabInsert(t, language)) {
      return "";
    }
    t = alignInsertWithContext(req, t);
    if (t.isEmpty()) {
      return "";
    }
    var lines = t.lines().toList();
    if (lines.size() > TAB_MAX_INSERT_LINES) {
      t = String.join("\n", lines.subList(0, TAB_MAX_INSERT_LINES));
    }
    if (t.length() > TAB_MAX_INSERT_CHARS) {
      t = t.substring(0, TAB_MAX_INSERT_CHARS);
    }
    return isValidTabInsert(t, language) ? t : "";
  }

  private static String alignInsertWithContext(PredictRequest req, String insert) {
    if (insert == null || insert.isBlank()) {
      return "";
    }
    String t = insert.strip();
    String pre = req.prefix() != null ? req.prefix() : "";
    String suf = req.suffix() != null ? req.suffix() : "";
    if (pre.endsWith(t) || suf.startsWith(t)) {
      return "";
    }
    String linePre =
        req.currentLinePrefix() != null && !req.currentLinePrefix().isBlank()
            ? req.currentLinePrefix()
            : lastLine(pre);
    if (t.length() >= 4 && linePre.contains(t)) {
      return "";
    }
    if (t.contains("trappedWater") && pre.contains("trappedWater") && !linePre.contains("trappedWater")) {
      return "";
    }
    return t;
  }

  /** Reject chat-style explanations mistaken for FIM insertions. */
  private static boolean isValidTabInsert(String text, String language) {
    if (text.isBlank() || looksLikeProseExplanation(text)) {
      return false;
    }
    if (isCodeLanguage(language)) {
      return looksLikeCodeInsert(text);
    }
    return true;
  }

  private static boolean isCodeLanguage(String language) {
    if (language == null || language.isBlank()) return false;
    String l = language.toLowerCase();
    return l.contains("cpp")
        || l.contains("c++")
        || l.equals("c")
        || l.contains("java")
        || l.contains("kotlin")
        || l.contains("rust")
        || l.contains("go")
        || l.contains("python")
        || l.contains("typescript")
        || l.contains("javascript");
  }

  private static boolean looksLikeEditPredictionJson(String t) {
    if (!t.startsWith("{")) return false;
    return t.contains("\"predictions\"")
        || t.contains("\"insertText\"")
        || t.contains("\"location\"")
        || t.contains("\"anchor\"");
  }

  private static boolean looksLikeProseExplanation(String t) {
    String lower = t.toLowerCase();
    if (looksLikeEditPredictionJson(t)) return true;
    if (t.contains("**") || t.contains("## ") || t.contains("```")) return true;
    if (t.contains("代码分析") || t.contains("我来逐行") || t.contains("典型")) return true;
    if (t.startsWith("这是一个")) return true;
    if (lower.startsWith("the output") || lower.contains("would be:")) return true;
    long han =
        t.codePoints().filter(cp -> Character.UnicodeScript.of(cp) == Character.UnicodeScript.HAN).count();
    if (han >= 6 && !looksLikeCodeInsert(t)) return true;
    if (t.split("\\s+").length > 12 && !t.contains(";") && !t.contains("<<")) return true;
    return false;
  }

  private static boolean looksLikeCodeInsert(String t) {
    if (t.contains(";")
        || t.contains("{")
        || t.contains("}")
        || t.contains("<<")
        || t.contains(">>")
        || t.contains("::")
        || t.contains("->")
        || t.contains("=")) {
      return true;
    }
    if (t.matches("^[\\s\"'0-9.+\\-()]+$")) return true;
    if (!t.contains(" ") && t.length() <= 48) return true;
    return false;
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
              "range", Map.of("startLine", req.cursorLine(), "endLine", req.cursorLine()),
              "newText", "\n" + indent + "}",
              "confidence", 0.72));
    }
    if (prefix.trim().endsWith("(") && !suffix.trim().startsWith(")")) {
      return List.of(
          Map.of(
              "path", req.filePath(),
              "range", Map.of("startLine", req.cursorLine(), "endLine", req.cursorLine()),
              "newText", ")",
              "confidence", 0.55));
    }
    return List.of();
  }

  private String emptyNote(PredictRequest req, boolean tryModel) {
    if (!tryModel) {
      return "No high-confidence edit inferred.";
    }
    boolean hasEnabledModel =
        modelService.listModelGroups().stream().anyMatch(ModelGroup::enabled);
    if (!hasEnabledModel) {
      return "No enabled model configured for tab prediction.";
    }
    return "Model produced no insert at cursor.";
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
      int cursorColumn,
      /** Text on the current line from line start to cursor (plugin-provided). */
      String currentLinePrefix,
      /** Text on the current line from cursor to line end (plugin-provided). */
      String currentLineSuffix) {}
}
