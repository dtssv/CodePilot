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
      if (c instanceof WebClientResponseException wcr && wcr.getStatusCode().is5xxServerError()) {
        return true;
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

  private static boolean isTransientIo(IOException e) {
    String msg = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
    return msg.contains("timeout")
        || msg.contains("reset")
        || msg.contains("refused")
        || msg.contains("broken pipe");
  }

  /** Emit user-safe error + terminal done; logs full cause server-side only. */
  public static void emitTerminalFailure(OverAllState state, String logContext, Throwable cause) {
    if (cause != null) {
      log.warn("{}: {}", logContext, cause.toString(), cause);
    } else {
      log.warn("{}", logContext);
    }
    GraphSseHelper.emitEvent(
        state, SseEvents.ERROR, Map.of("code", ErrorCodes.UPSTREAM_MODEL, "message", OPERATOR_MESSAGE));
    GraphSseHelper.emitEvent(state, SseEvents.DONE, Map.of("reason", "failed"));
  }

  /**
   * @return true if caller should return updates immediately (retry scheduled or terminal failure).
   */
  public static boolean handleGenerateLlmFailure(
      OverAllState state, Map<String, Object> updates, String phaseId, Exception e) {
    int retries = (int) state.value("generateLlmRetries").orElse(0);
    if (isRetryable(e) && retries < MAX_LLM_RETRIES) {
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
