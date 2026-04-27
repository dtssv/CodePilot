package io.codepilot.api.util;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.conversation.AgentEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;

/**
 * Shared helper for converting AgentEvent Flux to SSE Flux.
 */
public final class SseHelper {

  private static final Logger LOG = LoggerFactory.getLogger(SseHelper.class);
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private SseHelper() {}

  /** Converts an AgentEvent to its JSON string representation. */
  public static String toJson(AgentEvent event) {
    try {
      return MAPPER.writeValueAsString(event);
    } catch (Exception e) {
      LOG.error("Failed to serialize event: {}", e.getMessage());
      return "{\"code\":50001,\"message\":\"Serialization error\"}";
    }
  }

  /** Converts an AgentEvent Flux to an SSE Flux. */
  public static Flux<ServerSentEvent<String>> toSse(Flux<AgentEvent> events) {
    return events.map(event -> ServerSentEvent.<String>builder()
        .event(event.type())
        .data(toJson(event))
        .build());
  }
}