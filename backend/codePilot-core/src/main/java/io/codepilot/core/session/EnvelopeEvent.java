package io.codepilot.core.session;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * SSE envelope event following the v2 protocol consumed by the WebUI.
 *
 * <p>The WebUI's {@code turnReducer.ts} expects:
 *
 * <pre>
 * {
 *   "seq": 1,
 *   "turnId": "turn-xxx",
 *   "stepId": "step-1",
 *   "ts": 1718000000000,
 *   "type": "text.delta",
 *   "payload": { ... }
 * }
 * </pre>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EnvelopeEvent(
    int seq,
    String turnId,
    @JsonProperty("stepId") String stepId,
    @JsonProperty("parentStepId") String parentStepId,
    long ts,
    String type,
    Object payload) {
  public static EnvelopeEvent of(
      int seq, String turnId, String stepId, String type, Object payload) {
    return new EnvelopeEvent(seq, turnId, stepId, null, System.currentTimeMillis(), type, payload);
  }

  public static EnvelopeEvent toolCall(
      int seq, String turnId, String stepId, String tool, Map<String, Object> args) {
    return new EnvelopeEvent(
        seq,
        turnId,
        stepId,
        null,
        System.currentTimeMillis(),
        "tool.call",
        Map.of("stepId", stepId, "tool", tool, "args", args));
  }

  public static EnvelopeEvent toolResult(
      int seq, String turnId, String stepId, boolean ok, String result, String error) {
    return new EnvelopeEvent(
        seq,
        turnId,
        stepId,
        null,
        System.currentTimeMillis(),
        "tool.result",
        Map.of("stepId", stepId, "ok", ok, "result", result, "error", error));
  }
}
