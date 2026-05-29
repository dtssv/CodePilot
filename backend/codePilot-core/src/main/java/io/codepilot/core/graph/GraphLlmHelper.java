package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.PolicyChatOptions;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.sse.SseEvents;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
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

  /** If no LLM chunk arrives within this interval, emit a progress heartbeat SSE event. */
  static final long LLM_HEARTBEAT_INTERVAL_MS = 8000L;

  /**
   * Minimum interval between consecutive LLM API calls (ms).
   * Prevents rapid-fire requests that trigger "tokens limit for minute" rate limits.
   * Applied before every non-retry LLM call (retries already have exponential backoff).
   */
  static final long LLM_MIN_INTERVAL_MS = 3000L;

  /** Timestamp of the last completed LLM API call (non-retry), used for interval enforcement. */
  private static volatile long lastCallTimestampMs = 0L;

  /**
   * Enforce minimum interval between LLM calls. Sleeps if the last call was too recent.
   * Only applied for initial calls (attempt==1), not for retries which already have backoff.
   */
  static void enforceCallInterval() {
    long now = System.currentTimeMillis();
    long elapsed = now - lastCallTimestampMs;
    if (elapsed < LLM_MIN_INTERVAL_MS && lastCallTimestampMs > 0) {
      long waitMs = LLM_MIN_INTERVAL_MS - elapsed;
      log.info("LLM call interval enforcement: waiting {}ms (elapsed={}ms, min={}ms)",
              waitMs, elapsed, LLM_MIN_INTERVAL_MS);
      sleepQuietly(waitMs);
    }
  }

  static void markCallCompleted() {
    lastCallTimestampMs = System.currentTimeMillis();
  }

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
    return callWithTransientRetry(state,
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
        return collectStreamWithHeartbeat(spec.stream().chatResponse(), onChunk, state);
      }
    }
    var spec = chatClient.prompt().user(userPrompt);
    if (opts != null) spec = spec.options(opts);
    return collectStreamWithHeartbeat(spec.stream().chatResponse(), onChunk, state);
  }

  public static String streamSystemUser(
      ChatClient chatClient,
      OverAllState state,
      String system,
      String user,
      Consumer<String> onChunk) {
    return callWithTransientRetry(state,
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
    return collectStreamWithHeartbeat(spec.stream().chatResponse(), onChunk, state);
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
    boolean rateLimited = false;
    try {
      T result = action.get();
      success = true;
      return result;
    } catch (WebClientResponseException.TooManyRequests e) {
      // ★ 429 rate-limit: open circuit-breaker immediately for this appKey.
      // This signals that the appKey's quota is exhausted, allowing other keys
      // in the same group (if configured) to take over on the next request.
      rateLimited = true;
      throw e;
    } finally {
      if (rateLimited) {
        resolved.endRequestRateLimited();
      } else {
        resolved.endRequest(success, 0);
      }
    }
  }

  static <T> T callWithTransientRetry(OverAllState state, Supplier<T> call) {
    // ★ Enforce minimum interval before the first attempt of each new LLM call.
    // Retries (attempt > 1) already have exponential backoff, so they don't need this.
    enforceCallInterval();

    WebClientResponseException last = null;
    for (int attempt = 1; attempt <= INLINE_MAX_ATTEMPTS; attempt++) {
      try {
        T result = call.get();
        markCallCompleted(); // ★ Record successful call timestamp for interval enforcement
        return result;
      } catch (WebClientResponseException e) {
        last = e;
        if (attempt < INLINE_MAX_ATTEMPTS && GraphFailurePolicy.isRetryable(e)) {
          // ★ Adaptive backoff: "tokens limit for minute" needs much longer waits
          // than "request limit for seconds". A single 29万chars prompt can consume
          // the entire minute-level token budget, so we need to wait 30-60s.
          long backoffMs = computeBackoffMs(attempt, e.getResponseBodyAsString());
          log.warn(
              "LLM transient HTTP {} (attempt {}/{}), retrying after {}ms: {}",
              e.getStatusCode().value(),
              attempt,
              INLINE_MAX_ATTEMPTS,
              backoffMs,
              abbreviateForLog(e.getResponseBodyAsString(), 200));
          // ★ Emit SSE event so client knows the system is retrying, not stuck
          emitRateLimitRetry(state, attempt, backoffMs);
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

  /**
   * Compute adaptive backoff based on the 429 cause.
   *
   * <p>"tokens limit for minute" — the API's per-minute token budget is exhausted.
   * Standard exponential backoff (1.5s → 3s → 6s) is far too short because
   * a single large prompt can consume the entire minute budget.
   * We need to wait 30-60s for the budget to reset.
   *
   * <p>"request limit for seconds" — the per-second request limit was hit.
   * Standard backoff is appropriate (1.5s → 3s → 6s).
   *
   * <p>For other retryable errors, use standard exponential backoff.
   */
  static long computeBackoffMs(int attempt, String responseBody) {
    // Standard exponential backoff: 1.5s, 3s, 6s, 12s
    long standardBackoff = INLINE_BASE_BACKOFF_MS * (1L << (attempt - 1));

    if (responseBody != null && responseBody.contains("tokens limit for minute")) {
      // Token-minute budget: need to wait until the minute window resets.
      // Start at 30s and increase: 30s, 45s, 60s
      long[] minuteBackoffs = {30000L, 45000L, 60000L, 60000L};
      int idx = Math.min(attempt - 1, minuteBackoffs.length - 1);
      return minuteBackoffs[idx];
    }

    return standardBackoff;
  }

  private static String collectStream(
      reactor.core.publisher.Flux<ChatResponse> flux, Consumer<String> onChunk, OverAllState state) {
    var acc = new StringBuilder();
    AtomicLong lastChunkTime = new AtomicLong(System.currentTimeMillis());
    flux.map(GraphLlmHelper::deltaFromChatResponse)
        .filter(s -> !s.isBlank())
        .doOnNext(
            chunk -> {
              acc.append(chunk);
              lastChunkTime.set(System.currentTimeMillis());
              if (onChunk != null) {
                onChunk.accept(chunk);
              }
            })
        .blockLast();
    return acc.toString();
  }

  /**
   * Collects a streaming LLM response with periodic heartbeat SSE events.
   * When no chunk arrives for {@link #LLM_HEARTBEAT_INTERVAL_MS}, emits an
   * {@code agent_progress} event so the client knows the system is still working.
   *
   * <p>Uses a daemon timer thread to detect long silences during the blocking
   * {@code blockLast()} call, since the LLM may take minutes to produce
   * a response for complex tasks.
   */
  static String collectStreamWithHeartbeat(
      reactor.core.publisher.Flux<ChatResponse> flux, Consumer<String> onChunk, OverAllState state) {
    var acc = new StringBuilder();
    AtomicLong lastChunkTime = new AtomicLong(System.currentTimeMillis());
    AtomicLong lastHeartbeatTime = new AtomicLong(System.currentTimeMillis());

    // Start a daemon timer thread that emits heartbeats during long silences
    java.util.concurrent.atomic.AtomicBoolean done = new java.util.concurrent.atomic.AtomicBoolean(false);
    Thread heartbeatThread = new Thread(() -> {
      while (!done.get()) {
        try {
          Thread.sleep(LLM_HEARTBEAT_INTERVAL_MS);
        } catch (InterruptedException e) {
          break;
        }
        if (done.get()) break;
        long now = System.currentTimeMillis();
        if (now - lastHeartbeatTime.get() >= LLM_HEARTBEAT_INTERVAL_MS) {
          maybeEmitHeartbeat(state, lastHeartbeatTime, now);
        }
      }
    }, "llm-heartbeat");
    heartbeatThread.setDaemon(true);
    heartbeatThread.start();

    try {
      flux.map(GraphLlmHelper::deltaFromChatResponse)
          .filter(s -> !s.isBlank())
          .doOnNext(
              chunk -> {
                acc.append(chunk);
                long now = System.currentTimeMillis();
                lastChunkTime.set(now);
                lastHeartbeatTime.set(now);
                if (onChunk != null) {
                  onChunk.accept(chunk);
                }
              })
          .blockLast();
    } finally {
      done.set(true);
      heartbeatThread.interrupt();
    }
    return acc.toString();
  }

  /** Emits a heartbeat SSE event if enough time has passed since the last one. */
  private static void maybeEmitHeartbeat(OverAllState state, AtomicLong lastHeartbeatTime, long now) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    String node = (String) state.value("currentNode").orElse("generate");
    String message;
    switch (node) {
      case "generate", "reenter" -> message = "正在生成代码...";
      case "planning" -> message = "正在规划任务...";
      case "gather" -> message = "正在收集信息...";
      default -> message = "正在处理中...";
    }
    GraphSseHelper.emitEvent(state, SseEvents.AGENT_PROGRESS,
        Map.of("text", message, "phaseId", phaseId, "node", node));
    lastHeartbeatTime.set(now);
  }

  /** Emits an SSE event when a rate-limit retry occurs so the client knows the system is retrying. */
  private static void emitRateLimitRetry(OverAllState state, int attempt, long backoffMs) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    GraphSseHelper.emitEvent(state, SseEvents.AGENT_PROGRESS,
        Map.of("text", "请求频率限制，正在重试 (" + attempt + "/" + INLINE_MAX_ATTEMPTS + ")...",
            "phaseId", phaseId, "reason", "rate_limit_retry", "backoffMs", backoffMs));
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
