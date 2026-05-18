package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.PolicyChatOptions;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Applies graph policy (Max / output budget) to ChatClient calls. */
public final class GraphLlmHelper {

  private GraphLlmHelper() {}

  @SuppressWarnings("unchecked")
  public static String completeUserPrompt(ChatClient chatClient, OverAllState state, String userPrompt) {
    List<Map<String, String>> history =
        (List<Map<String, String>>) state.value("conversationHistory").orElse(List.of());
    OpenAiChatOptions opts = optionsFromState(state);
    if (!history.isEmpty()) {
      var messages = new ArrayList<Message>();
      for (var histMsg : history) {
        String role = histMsg.getOrDefault("role", "");
        String content = histMsg.getOrDefault("content", "");
        if (content == null || content.isBlank()) continue;
        if ("user".equals(role)) messages.add(new UserMessage(content));
        else if ("assistant".equals(role)) messages.add(new AssistantMessage(content));
      }
      if (!messages.isEmpty()) {
        messages.add(new UserMessage(userPrompt));
        var spec = chatClient.prompt(Prompt.builder().messages(messages).build());
        if (opts != null) spec = spec.options(opts);
        return spec.call().content();
      }
    }
    var spec = chatClient.prompt().user(userPrompt);
    if (opts != null) spec = spec.options(opts);
    return spec.call().content();
  }

  public static String completeSystemUser(
      ChatClient chatClient, OverAllState state, String system, String user) {
    OpenAiChatOptions opts = optionsFromState(state);
    var spec = chatClient.prompt().system(system).user(user);
    if (opts != null) spec = spec.options(opts);
    return spec.call().content();
  }

  private static OpenAiChatOptions optionsFromState(OverAllState state) {
    Boolean maxMode = state.value("maxMode").map(v -> (Boolean) v).orElse(false);
    String thinking = state.value("thinkingMode").map(Object::toString).orElse(null);
    Integer maxOut =
        state.value("maxOutputTokens")
            .map(v -> v instanceof Number n ? n.intValue() : null)
            .orElse(null);
    String modelId = state.value("modelId").map(Object::toString).orElse(null);
    return PolicyChatOptions.fromGraphState(maxMode, thinking, maxOut, modelId);
  }
}
