package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.PolicyChatOptions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatOptions;

/** Applies graph policy (Max / output budget) to ChatClient calls. */
public final class GraphLlmHelper {

  private GraphLlmHelper() {}

  @SuppressWarnings("unchecked")
  public static String completeUserPrompt(ChatClient chatClient, OverAllState state, String userPrompt) {
    return streamUserPrompt(chatClient, state, userPrompt, null);
  }

  public static String completeSystemUser(
      ChatClient chatClient, OverAllState state, String system, String user) {
    return streamSystemUser(chatClient, state, system, user, null);
  }

  /** Streams tokens to {@code onChunk} when provided; always returns the full response text. */
  @SuppressWarnings("unchecked")
  public static String streamUserPrompt(
      ChatClient chatClient,
      OverAllState state,
      String userPrompt,
      Consumer<String> onChunk) {
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
        return collectStream(spec.stream().chatResponse(), onChunk);
      }
    }
    var spec = chatClient.prompt().user(userPrompt);
    if (opts != null) spec = spec.options(opts);
    return collectStream(spec.stream().chatResponse(), onChunk);
  }

  public static String streamSystemUser(
      ChatClient chatClient,
      OverAllState state,
      String system,
      String user,
      Consumer<String> onChunk) {
    OpenAiChatOptions opts = optionsFromState(state);
    var spec = chatClient.prompt().system(system).user(user);
    if (opts != null) spec = spec.options(opts);
    return collectStream(spec.stream().chatResponse(), onChunk);
  }

  /** Marker-aware streaming to SSE; sets stream flags on {@code updates} when non-null. */
  public static String streamUserPromptToSse(
      ChatClient chatClient,
      OverAllState state,
      String userPrompt,
      Map<String, Object> updates) {
    return streamUserPromptToSse(chatClient, state, userPrompt, updates, false);
  }

  /**
   * @param structuredEnvelope when true, drops plain-text preamble before markers/JSON and limits
   *     duplicate AGENT_CONTENT / AGENT_THINKING blocks to one each per call
   */
  public static String streamUserPromptToSse(
      ChatClient chatClient,
      OverAllState state,
      String userPrompt,
      Map<String, Object> updates,
      boolean structuredEnvelope) {
    String action = (String) state.value("currentNode").orElse("llm");
    GraphExecutionLog.llmRequest(state, action, userPrompt);
    var processor = new GraphStreamProcessor(state, structuredEnvelope);
    String response =
        streamUserPrompt(chatClient, state, userPrompt, processor::onChunk);
    processor.finish();
    if (updates != null) {
      updates.put("agentContentStreamed", processor.agentContentStreamed());
      updates.put("agentThinkingEmitted", processor.agentThinkingEmitted());
      updates.put("plainTextStreamed", processor.plainTextStreamed());
      GraphExecutionLog.llmResponse(state, action, response, updates);
    } else {
      GraphExecutionLog.llmResponse(state, action, response, Map.of());
    }
    return response;
  }

  public static String streamSystemUserToSse(
      ChatClient chatClient,
      OverAllState state,
      String system,
      String user,
      Map<String, Object> updates) {
    var processor = new GraphStreamProcessor(state);
    String response =
        streamSystemUser(chatClient, state, system, user, processor::onChunk);
    processor.finish();
    if (updates != null) {
      updates.put("agentContentStreamed", processor.agentContentStreamed());
      updates.put("agentThinkingEmitted", processor.agentThinkingEmitted());
    }
    return response;
  }

  private static String collectStream(
      reactor.core.publisher.Flux<ChatResponse> flux, Consumer<String> onChunk) {
    var acc = new StringBuilder();
    flux.map(GraphLlmHelper::deltaFromChatResponse)
        .filter(s -> !s.isBlank())
        .doOnNext(
            chunk -> {
              acc.append(chunk);
              if (onChunk != null) {
                onChunk.accept(chunk);
              }
            })
        .blockLast();
    return acc.toString();
  }

  private static String deltaFromChatResponse(ChatResponse r) {
    if (r == null || r.getResult() == null || r.getResult().getOutput() == null) return "";
    String text = r.getResult().getOutput().getText();
    return text != null ? text : "";
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
