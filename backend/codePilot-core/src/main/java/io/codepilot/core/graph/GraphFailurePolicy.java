package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.sse.SseEvents;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import org.springframework.web.reactive.function.client.WebClientResponseException;

/**
 * Action-level failure handling: retry transient upstream errors (e.g. model timeout), never
 * surface raw backend exceptions via askUser.
 */
public final class GraphFailurePolicy {

  private static final Logger log = LoggerFactory.getLogger(GraphFailurePolicy.class);

  /** Max automatic retries per generate/repair LLM call. */
  public static final int MAX_LLM_RETRIES = 3;

  private static final String OPERATOR_MESSAGE =
      "当前请求处理失败，请稍后重试。若问题持续出现，请联系运营人员排查。";

  /** User-friendly message for 4xx client errors (bad request, unsupported parameters, etc.). */
  private static final String BAD_REQUEST_MESSAGE =
      "模型请求参数异常，请检查模型配置后重试。若问题持续出现，请联系运营人员排查。";

  private static final String RATE_LIMIT_MESSAGE =
      "模型服务请求过于频繁，请稍后再试。若问题持续出现，请联系运营人员排查。";

  private GraphFailurePolicy() {}

  /**
   * Programming bugs and bad state — retrying will not help.
   */
  public static boolean isNonRetryable(Throwable t) {
    for (Throwable c = t; c != null; c = c.getCause()) {
      if (c instanceof NullPointerException
          || c instanceof IllegalStateException
          || c instanceof IllegalArgumentException
          || c instanceof ClassCastException
          || c instanceof IndexOutOfBoundsException
          || c instanceof UnsupportedOperationException
          || c instanceof ArithmeticException) {
        return true;
      }
    }
    return false;
  }

  /**
   * Transient upstream / network / overload — safe to retry the same LLM call.
   *
   * <p>400 Bad Request is generally NOT retryable (same request will produce the same error),
   * but some providers return 400 for rate-limit or overload scenarios that ARE transient.
   * We check the response body for such indicators.
   */
  public static boolean isRetryable(Throwable t) {
    if (t == null || isNonRetryable(t)) {
      return false;
    }
    for (Throwable c = t; c != null; c = c.getCause()) {
      if (c instanceof TimeoutException
          || c instanceof SocketTimeoutException
          || c instanceof WebClientRequestException) {
        return true;
      }
      if (c instanceof IOException io && isTransientIo(io)) {
        return true;
      }
      if (c instanceof WebClientResponseException wcr) {
        if (wcr.getStatusCode().is5xxServerError()) {
          return true;
        }
        // Some providers return 400 for transient conditions (rate limit, overload, etc.)
        if (wcr.getStatusCode().value() == 400 && isTransientBadRequest(wcr)) {
          log.info("400 Bad Request with transient indicator, treating as retryable: {}",
              abbreviate(wcr.getResponseBodyAsString(), 200));
          return true;
        }
      }
      String msg = (c.getMessage() != null ? c.getMessage() : "").toLowerCase();
      String type = c.getClass().getSimpleName().toLowerCase();
      if (msg.contains("429")
          || msg.contains("rate limit")
          || msg.contains("too many requests")
          || msg.contains("timeout")
          || msg.contains("timed out")
          || type.contains("timeout")
          || msg.contains("503")
          || msg.contains("502")
          || msg.contains("504")
          || msg.contains("unavailable")
          || msg.contains("connection reset")
          || msg.contains("connection refused")
          || msg.contains("broken pipe")
          || msg.contains("temporarily")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks whether a 400 Bad Request response body contains indicators of a transient
   * (retryable) condition rather than a permanent parameter error.
   */
  static boolean isTransientBadRequest(WebClientResponseException wcr) {
    String body = wcr.getResponseBodyAsString();
    if (body == null || body.isBlank()) return false;
    String lower = body.toLowerCase();
    // Common transient indicators in 400 responses from AI providers
    return lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("rate limit reached")
        || lower.contains("too many requests")
        || lower.contains("quota exceeded")
        || lower.contains("capacity")
        || lower.contains("overloaded")
        || lower.contains("temporarily unavailable")
        || lower.contains("please retry")
        || lower.contains("please try again")
        || lower.contains("service is busy");
  }

  /**
   * Returns true if the exception is a non-retryable 4xx client error (e.g. 400 Bad Request
   * with invalid parameters) that should NOT be retried with the same payload.
   */
  public static boolean isClientError(Throwable t) {
    for (Throwable c = t; c != null; c = c.getCause()) {
      if (c instanceof WebClientResponseException wcr) {
        int status = wcr.getStatusCode().value();
        // 4xx client errors, excluding 429 (rate limit) which is retryable
        if (status >= 400 && status < 500 && status != 429) {
          return true;
        }
      }
    }
    return false;
  }

  private static boolean isTransientIo(IOException e) {
    String msg = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
    return msg.contains("timeout")
        || msg.contains("reset")
        || msg.contains("refused")
        || msg.contains("broken pipe");
  }

  /**
   * Emit user-safe error + terminal done; logs full cause server-side only.
   * Provides differentiated messages for client errors (4xx) vs server errors (5xx/network).
   */
  public static boolean isRateLimited(Throwable t) {
    for (Throwable c = t; c != null; c = c.getCause()) {
      if (c instanceof WebClientResponseException wcr) {
        if (wcr.getStatusCode().value() == 429 || isTransientBadRequest(wcr)) {
          return true;
        }
      }
      String msg = (c.getMessage() != null ? c.getMessage() : "").toLowerCase();
      if (msg.contains("rate limit") || msg.contains("too many requests")) {
        return true;
      }
    }
    return false;
  }

  public static void emitTerminalFailure(OverAllState state, String logContext, Throwable cause) {
    String userMessage = OPERATOR_MESSAGE;
    if (cause != null) {
      log.warn("{}: {}", logContext, cause.toString(), cause);
      if (isRateLimited(cause)) {
        userMessage = RATE_LIMIT_MESSAGE;
      } else if (isClientError(cause)) {
        userMessage = BAD_REQUEST_MESSAGE;
        // Log the response body for debugging — this is the key to diagnosing 400 errors
        for (Throwable c = cause; c != null; c = c.getCause()) {
          if (c instanceof WebClientResponseException wcr) {
            log.warn("{}: 4xx response body={}", logContext,
                abbreviate(wcr.getResponseBodyAsString(), 500));
            break;
          }
        }
      }
    } else {
      log.warn("{}", logContext);
    }
    GraphSseHelper.emitEvent(
        state, SseEvents.ERROR, Map.of("code", ErrorCodes.UPSTREAM_MODEL, "message", userMessage));
    GraphSseHelper.emitEvent(state, SseEvents.DONE, Map.of("reason", "failed"));
  }

  private static void backoffBeforeGraphRetry(int retryNumber, String context) {
    long backoffMs = GraphLlmHelper.INLINE_BASE_BACKOFF_MS * (1L << Math.max(0, retryNumber - 1));
    log.info("{}: backing off {}ms before graph-level LLM retry", context, backoffMs);
    try {
      Thread.sleep(backoffMs);
    } catch (InterruptedException ie) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Graph LLM retry interrupted: " + context, ie);
    }
  }

  /** Truncates a string for safe logging (avoids dumping huge response bodies). */
  private static String abbreviate(String s, int maxLen) {
    if (s == null) return "null";
    return s.length() <= maxLen ? s : s.substring(0, maxLen) + "...[truncated]";
  }

  /**
   * @return true if caller should return updates immediately (retry scheduled or terminal failure).
   */
  public static boolean handleGenerateLlmFailure(
      OverAllState state, Map<String, Object> updates, String phaseId, Exception e) {
    int retries = (int) state.value("generateLlmRetries").orElse(0);
    if (isRetryable(e) && retries < MAX_LLM_RETRIES) {
      backoffBeforeGraphRetry(retries + 1, "GenerateAction phase=" + phaseId);
      updates.put("generateLlmRetries", retries + 1);
      updates.put("generateResult", "retryGenerate");
      log.info(
          "GenerateAction phase={}: retryable LLM failure, retry {}/{} ({})",
          phaseId,
          retries + 1,
          MAX_LLM_RETRIES,
          e.getClass().getSimpleName());
      return true;
    }
    emitTerminalFailure(state, "GenerateAction LLM failed phase=" + phaseId, e);
    updates.put("generateResult", "failed");
    return true;
  }

  public static boolean handleRepairLlmFailure(
      OverAllState state, Map<String, Object> updates, String phaseId, Exception e) {
    int retries = (int) state.value("repairLlmRetries").orElse(0);
    if (isRetryable(e) && retries < MAX_LLM_RETRIES) {
      backoffBeforeGraphRetry(retries + 1, "RepairAction phase=" + phaseId);
      updates.put("repairLlmRetries", retries + 1);
      updates.put("repairResult", "retryRepair");
      log.info(
          "RepairAction phase={}: retryable LLM failure, retry {}/{} ({})",
          phaseId,
          retries + 1,
          MAX_LLM_RETRIES,
          e.getClass().getSimpleName());
      return true;
    }
    emitTerminalFailure(state, "RepairAction LLM failed phase=" + phaseId, e);
    updates.put("repairResult", "failed");
    return true;
  }
}
