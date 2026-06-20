package io.codepilot.core.sse;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;

/** Tiny helper to build ServerSentEvents with JSON-encoded payloads. */
@Component
public class SseFactory {

  private final ObjectMapper mapper;

  public SseFactory(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  public ServerSentEvent<String> event(String name, Object payload) {
    try {
      return ServerSentEvent.<String>builder()
          .event(name)
          .data(mapper.writeValueAsString(payload))
          .build();
    } catch (Exception e) {
      return ServerSentEvent.<String>builder().event(name).data("{}").build();
    }
  }

  public ServerSentEvent<String> error(int code, String message) {
    return event(SseEvents.ERROR, Map.of("code", code, "message", message));
  }
}
