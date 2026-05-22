package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.PolicyChatOptions;
import io.codepilot.core.model.ChatClientFactory;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.web.reactive.function.client.WebClientResponseException;

/** Applies graph policy (Max / output budget) to ChatClient calls. */
public final class GraphLlmHelper {

  private GraphLlmHelper() {}

  private static final Logger log = LoggerFactory.getLogger(GraphLlmHelper.class);

  /** Inline retries per LLM HTTP call (transient rate-limit / overload / 5xx). */
  static final int INLINE_MAX_ATTEMPTS = 4;

  static final long INLINE_BASE_BACKOFF_MS = 1500L;

  @SuppressWarnings("unchecked")
  public static String completeUserPrompt(
      ChatClientFactory.ResolvedClient resolved, OverAllState state, String userPrompt) {
    return withResolvedClient(resolved, () -> streamUserPrompt(resolved.chatClient(), state, userPrompt, null));
  }

  public static String completeSystemUser(
      ChatClientFactory.ResolvedClient resolved, OverAllState state, String system, String user) {
    return withResolvedClient(
        resolved, () -> streamSystemUser(resolved.chatClient(), state, system, user, null));
  }

  /** Streams tokens to {@code onChunk} when provided; always returns the full response text. */
  @SuppressWarnings("unchecked")
  public static String streamUserPrompt(
      ChatClient chatClient,
      OverAllState state,
      String userPrompt,
      Consumer<String> onChunk) {
    return callWithTransientRetry(
        () -> streamUserPromptOnce(chatClient, state, userPrompt, onChunk));
  }

  @SuppressWarnings("unchecked")
  private static String streamUserPromptOnce(
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
    return callWithTransientRetry(
        () -> streamSystemUserOnce(chatClient, state, system, user, onChunk));
  }

  private static String streamSystemUserOnce(
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
      ChatClientFactory.ResolvedClient resolved,
      OverAllState state,
      String userPrompt,
      Map<String, Object> updates) {
    return streamUserPromptToSse(resolved, state, userPrompt, updates, false);
  }

  /**
   * @param structuredEnvelope when true, drops plain-text preamble before markers/JSON and limits
   *     duplicate AGENT_CONTENT / AGENT_THINKING blocks to one each per call
   */
  public static String streamUserPromptToSse(
      ChatClientFactory.ResolvedClient resolved,
      OverAllState state,
      String userPrompt,
      Map<String, Object> updates,
      boolean structuredEnvelope) {
    return withResolvedClient(
        resolved,
        () -> {
          String action = (String) state.value("currentNode").orElse("llm");
          GraphExecutionLog.llmRequest(state, action, userPrompt);
          var processor = new GraphStreamProcessor(state, structuredEnvelope);
          String response =
              streamUserPrompt(resolved.chatClient(), state, userPrompt, processor::onChunk);
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
        });
  }

  public static String streamSystemUserToSse(
      ChatClientFactory.ResolvedClient resolved,
      OverAllState state,
      String system,
      String user,
      Map<String, Object> updates) {
    return withResolvedClient(
        resolved,
        () -> {
          var processor = new GraphStreamProcessor(state);
          String response =
              streamSystemUser(resolved.chatClient(), state, system, user, processor::onChunk);
          processor.finish();
          if (updates != null) {
            updates.put("agentContentStreamed", processor.agentContentStreamed());
            updates.put("agentThinkingEmitted", processor.agentThinkingEmitted());
          }
          return response;
        });
  }

  static <T> T withResolvedClient(ChatClientFactory.ResolvedClient resolved, Supplier<T> action) {
    resolved.startRequest();
    boolean success = false;
    try {
      T result = action.get();
      success = true;
      return result;
    } finally {
      resolved.endRequest(success, 0);
    }
  }

  static <T> T callWithTransientRetry(Supplier<T> call) {
    WebClientResponseException last = null;
    for (int attempt = 1; attempt <= INLINE_MAX_ATTEMPTS; attempt++) {
      try {
        return call.get();
      } catch (WebClientResponseException e) {
        last = e;
        if (attempt < INLINE_MAX_ATTEMPTS && GraphFailurePolicy.isRetryable(e)) {
          long backoffMs = INLINE_BASE_BACKOFF_MS * (1L << (attempt - 1));
          log.warn(
              "LLM transient HTTP {} (attempt {}/{}), retrying after {}ms: {}",
              e.getStatusCode().value(),
              attempt,
              INLINE_MAX_ATTEMPTS,
              backoffMs,
              abbreviateForLog(e.getResponseBodyAsString(), 200));
          sleepQuietly(backoffMs);
          continue;
        }
        log.error(
            "LLM API returned HTTP {}: response body={}",
            e.getStatusCode().value(),
            abbreviateForLog(e.getResponseBodyAsString(), 500));
        throw e;
      }
    }
    throw last;
  }

  private static void sleepQuietly(long backoffMs) {
    try {
      Thread.sleep(backoffMs);
    } catch (InterruptedException ie) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("LLM retry interrupted", ie);
    }
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

  private static String abbreviateForLog(String s, int maxLen) {
    if (s == null) return "null";
    return s.length() <= maxLen ? s : s.substring(0, maxLen) + "...[truncated]";
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
