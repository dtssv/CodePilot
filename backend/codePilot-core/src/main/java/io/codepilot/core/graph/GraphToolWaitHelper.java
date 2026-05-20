package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.sse.SseEvents;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Heartbeat progress while blocking on client tool results during graph execution. */
public final class GraphToolWaitHelper {

  private static final Duration HEARTBEAT = Duration.ofSeconds(2);

  private GraphToolWaitHelper() {}

  public static ToolResultEvent await(
      CompletableFuture<ToolResultEvent> future,
      OverAllState state,
      String progressText,
      Duration timeout)
      throws Exception {
    long deadlineNanos = System.nanoTime() + timeout.toNanos();
    int tick = 0;
    while (System.nanoTime() < deadlineNanos) {
      long remainingMs = (deadlineNanos - System.nanoTime()) / 1_000_000L;
      if (remainingMs <= 0) {
        break;
      }
      long sliceMs = Math.min(HEARTBEAT.toMillis(), remainingMs);
      try {
        return future.get(sliceMs, TimeUnit.MILLISECONDS);
      } catch (TimeoutException e) {
        tick++;
        emitHeartbeat(state, progressText, tick);
      }
    }
    throw new TimeoutException(progressText);
  }

  /** Waits for all futures in parallel, emitting heartbeats until all complete or timeout. */
  public static void awaitAll(
      List<CompletableFuture<ToolResultEvent>> futures,
      OverAllState state,
      String progressText,
      Duration timeout)
      throws Exception {
    if (futures.isEmpty()) {
      return;
    }
    if (futures.size() == 1) {
      await(futures.get(0), state, progressText, timeout);
      return;
    }
    long deadlineNanos = System.nanoTime() + timeout.toNanos();
    int tick = 0;
    List<CompletableFuture<ToolResultEvent>> pending = new ArrayList<>(futures);
    while (!pending.isEmpty() && System.nanoTime() < deadlineNanos) {
      long remainingMs = (deadlineNanos - System.nanoTime()) / 1_000_000L;
      if (remainingMs <= 0) {
        break;
      }
      long sliceMs = Math.min(HEARTBEAT.toMillis(), remainingMs);
      pending.removeIf(
          f -> {
            if (f.isDone()) {
              return true;
            }
            try {
              f.get(sliceMs, TimeUnit.MILLISECONDS);
              return true;
            } catch (TimeoutException e) {
              return false;
            } catch (Exception e) {
              return true;
            }
          });
      if (!pending.isEmpty()) {
        tick++;
        emitHeartbeat(state, progressText, tick);
      }
    }
    for (CompletableFuture<ToolResultEvent> f : pending) {
      if (!f.isDone()) {
        throw new TimeoutException(progressText);
      }
    }
  }

  private static void emitHeartbeat(OverAllState state, String progressText, int tick) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    GraphSseHelper.emitEvent(
        state,
        SseEvents.GRAPH_TRANSITION,
        Map.of("to", "waiting", "phaseId", phaseId, "elapsedSec", tick * HEARTBEAT.toSeconds()));
  }
}
