package io.codepilot.api.fim;

import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ChatClientFactory.ResolvedClient;
import io.codepilot.core.model.ModelGroup;
import io.codepilot.core.model.ModelService;
import org.springframework.stereotype.Service;

/**
 * Synchronous FIM infill for tab prediction and other non-streaming callers.
 * Mirrors format detection from {@link io.codepilot.api.action.FimNativeController}.
 */
@Service
public class FimSyncCompleter {

  private final ChatClientFactory clientFactory;
  private final ModelService modelService;

  public FimSyncCompleter(ChatClientFactory clientFactory, ModelService modelService) {
    this.clientFactory = clientFactory;
    this.modelService = modelService;
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
        String completion =
            resolved.chatClient().prompt().user(content).call().content();
        return completion != null ? completion.strip() : "";
      } finally {
        resolved.endRequest(true, 0);
      }
    } catch (Exception e) {
      return "";
    }
  }

  public String pickFimCoderModel() {
    return modelService.listModelGroups().stream()
        .filter(ModelGroup::enabled)
        .filter(
            g -> {
              String m = g.model() != null ? g.model().toLowerCase() : "";
              return m.contains("codestral")
                  || m.contains("deepseek")
                  || m.contains("starcoder")
                  || (m.contains("qwen") && m.contains("coder"))
                  || m.contains("codellama")
                  || (g.capabilities() != null && g.capabilities().contains("fim"));
            })
        .map(ModelGroup::model)
        .findFirst()
        .orElse(null);
  }

  static String buildFimUserContent(String modelId, String prefix, String suffix) {
    return switch (detectFimFormat(modelId)) {
      case "deepseek" ->
          "<｜fim▁begin｜>"
              + prefix
              + "<｜fim▁hole｜>"
              + suffix
              + "<｜fim▁end｜>";
      case "codestral" ->
          "Complete the code between PREFIX and SUFFIX. Output only the middle insertion.\n\n"
              + "PREFIX:\n"
              + prefix
              + "\n\nSUFFIX:\n"
              + suffix;
      default ->
          "<fim_prefix>"
              + prefix
              + "<fim_suffix>"
              + suffix
              + "<fim_middle>";
    };
  }

  static String detectFimFormat(String modelId) {
    if (modelId == null) return "starcoder";
    String lower = modelId.toLowerCase();
    if (lower.contains("codestral") || lower.contains("mistral")) return "codestral";
    if (lower.contains("deepseek")) return "deepseek";
    return "starcoder";
  }
}
