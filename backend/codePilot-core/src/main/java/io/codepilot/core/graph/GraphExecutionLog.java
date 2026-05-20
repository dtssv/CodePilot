package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Structured execution trace for graph runs (filter loggers by {@code io.codepilot.graph.execution}). */
public final class GraphExecutionLog {

  public static final Logger LOG = LoggerFactory.getLogger("io.codepilot.graph.execution");

  private GraphExecutionLog() {}

  public static void runStart(String sessionId, String mode, String inputPreview) {
    LOG.info("[graph.run.start] sessionId={} mode={} input={}", sessionId, mode, preview(inputPreview, 300));
  }

  public static void runEnd(String sessionId, String status, Object detail) {
    LOG.info("[graph.run.end] sessionId={} status={} detail={}", sessionId, status, detail);
  }

  public static void nodeEnter(OverAllState state, String node) {
    LOG.info(
        "[graph.node.enter] sessionId={} node={} phase={}",
        sessionId(state),
        node,
        state.value("phaseCursor").orElse(""));
  }

  public static void nodeExit(OverAllState state, String node, Map<String, Object> updates) {
    LOG.info(
        "[graph.node.exit] sessionId={} node={} phase={} keys={} planningResult={} generateResult={} verifyResult={}",
        sessionId(state),
        node,
        updates != null ? updates.getOrDefault("phaseCursor", state.value("phaseCursor").orElse("")) : "",
        updates != null ? updates.keySet() : "null",
        updates != null ? updates.get("planningResult") : null,
        updates != null ? updates.get("generateResult") : null,
        updates != null ? updates.get("verifyResult") : null);
  }

  public static void llmRequest(OverAllState state, String action, String prompt) {
    LOG.info(
        "[graph.llm.request] sessionId={} action={} phase={} promptChars={} prompt={}",
        sessionId(state),
        action,
        state.value("phaseCursor").orElse(""),
        prompt != null ? prompt.length() : 0,
        preview(prompt, 400));
  }

  public static void llmResponse(OverAllState state, String action, String response, Map<String, Object> streamFlags) {
    LOG.info(
        "[graph.llm.response] sessionId={} action={} phase={} responseChars={} contentStreamed={} thinkingEmitted={} plainStreamed={} preview={}",
        sessionId(state),
        action,
        state.value("phaseCursor").orElse(""),
        response != null ? response.length() : 0,
        streamFlags != null ? streamFlags.get("agentContentStreamed") : null,
        streamFlags != null ? streamFlags.get("agentThinkingEmitted") : null,
        streamFlags != null ? streamFlags.get("plainTextStreamed") : null,
        preview(response, 500));
  }

  public static void sseEmit(OverAllState state, String eventType, Object data) {
    LOG.debug("[graph.sse.emit] sessionId={} event={} data={}", sessionId(state), eventType, previewData(data));
  }

  public static void toolCallEmit(OverAllState state, String toolCallId, String toolName, Object args) {
    LOG.info(
        "[graph.tool.call] sessionId={} toolCallId={} tool={} args={}",
        sessionId(state),
        toolCallId,
        toolName,
        previewData(args));
  }

  public static void toolResultIn(String sessionId, String toolCallId, boolean ok, Object result, String error) {
    LOG.info(
        "[graph.tool.result.in] sessionId={} toolCallId={} ok={} error={} result={}",
        sessionId,
        toolCallId,
        ok,
        error,
        previewData(result));
  }

  public static void toolResultAwait(OverAllState state, String toolCallId, boolean ok, String error) {
    LOG.info(
        "[graph.tool.result.await] sessionId={} toolCallId={} ok={} error={}",
        sessionId(state),
        toolCallId,
        ok,
        error);
  }

  private static String sessionId(OverAllState state) {
    return (String) state.value("sessionId").orElse("");
  }

  private static String preview(String text, int max) {
    if (text == null) {
      return "";
    }
    String oneLine = text.replace('\n', ' ').replace('\r', ' ').trim();
    if (oneLine.length() <= max) {
      return oneLine;
    }
    return oneLine.substring(0, max) + "…";
  }

  private static String previewData(Object data) {
    if (data == null) {
      return "null";
    }
    if (data instanceof Map<?, ?> m) {
      return preview(m.toString(), 400);
    }
    return preview(String.valueOf(data), 400);
  }
}
