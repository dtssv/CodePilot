package io.codepilot.api.fim;

import com.google.common.io.Resources;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ChatClientFactory.ResolvedClient;
import io.codepilot.core.model.ModelGroup;
import io.codepilot.core.model.ModelService;
import java.nio.charset.StandardCharsets;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.stereotype.Service;

/**
 * Synchronous FIM infill for tab prediction. Model choice is not restricted — any enabled model
 * group may be used; {@code prompts/tab.infill.txt} and FIM markers constrain the output.
 */
@Service
public class FimSyncCompleter {

  private static final String TAB_INFILL_RULES = loadTabInfillRules();

  private final ChatClientFactory clientFactory;
  private final ModelService modelService;

  public FimSyncCompleter(ChatClientFactory clientFactory, ModelService modelService) {
    this.clientFactory = clientFactory;
    this.modelService = modelService;
  }

  /** First enabled model (by sortOrder). No coder/FIM capability gate. */
  public String pickTabPredictModel() {
    return modelService.listModelGroups().stream()
        .filter(ModelGroup::enabled)
        .filter(g -> g.model() != null && !g.model().isBlank())
        .sorted(java.util.Comparator.comparingInt(ModelGroup::sortOrder))
        .map(ModelGroup::model)
        .findFirst()
        .orElse(null);
  }

  /**
   * @deprecated use {@link #pickTabPredictModel()}
   */
  @Deprecated
  public String pickAnyEnabledModel() {
    return pickTabPredictModel();
  }

  /**
   * @deprecated use {@link #pickTabPredictModel()}
   */
  @Deprecated
  public String pickFimCoderModel() {
    return pickTabPredictModel();
  }

  /**
   * @deprecated use {@link #pickTabPredictModel()}
   */
  @Deprecated
  public String pickTabInfillModel() {
    return pickTabPredictModel();
  }

  /** Returns insertion text only, or empty string on failure. */
  public String complete(String modelId, String prefix, String suffix, int maxTokens) {
    if (modelId == null || modelId.isBlank()) return "";
    String prompt = prefix != null ? prefix : "";
    String suf = suffix != null ? suffix : "";
    try {
      ResolvedClient resolved = clientFactory.resolve(modelId, null);
      resolved.startRequest();
      try {
        String content = buildFimUserContent(modelId, prompt, suf);
        int tokens = Math.max(16, Math.min(maxTokens, 128));
        OpenAiChatOptions options =
            OpenAiChatOptions.builder().temperature(0.05).maxTokens(tokens).build();
        String completion =
            resolved.chatClient().prompt().user(content).options(options).call().content();
        return completion != null ? completion.strip() : "";
      } finally {
        resolved.endRequest(true, 0);
      }
    } catch (Exception e) {
      return "";
    }
  }

  static String buildFimUserContent(String modelId, String prefix, String suffix) {
    String rules = TAB_INFILL_RULES.isBlank() ? INSERT_ONLY_FALLBACK : TAB_INFILL_RULES;
    return switch (detectFimFormat(modelId)) {
      case "deepseek" ->
          rules
              + "\n\n<｜fim▁begin｜>"
              + prefix
              + "<｜fim▁hole｜>"
              + suffix
              + "<｜fim▁end｜>\nINSERTION:";
      case "codestral" ->
          rules + "\n\nPREFIX:\n" + prefix + "\nSUFFIX:\n" + suffix + "\nMIDDLE (insertion only):";
      default -> rules + "\n\n<fim_prefix>" + prefix + "<fim_suffix>" + suffix + "<fim_middle>";
    };
  }

  static String detectFimFormat(String modelId) {
    if (modelId == null) return "starcoder";
    String lower = modelId.toLowerCase();
    if (lower.contains("codestral") || lower.contains("mistral")) return "codestral";
    if (lower.contains("deepseek")) return "deepseek";
    return "starcoder";
  }

  private static final String INSERT_ONLY_FALLBACK =
      "Output ONLY raw code to insert between PREFIX and SUFFIX. "
          + "No JSON. No markdown. No explanation. Max 120 chars.\n\n";

  private static String loadTabInfillRules() {
    try {
      var url =
          Thread.currentThread().getContextClassLoader().getResource("prompts/tab.infill.txt");
      return url != null ? Resources.toString(url, StandardCharsets.UTF_8) : "";
    } catch (Exception e) {
      return "";
    }
  }
}
