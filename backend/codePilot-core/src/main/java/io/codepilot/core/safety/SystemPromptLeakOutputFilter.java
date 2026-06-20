package io.codepilot.core.safety;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.sse.SseEvents;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Stream-side defence: scans every {@code delta} chunk for hallmark phrases that would imply a
 * system / Skill prompt leak. On a hit, the remaining stream is short-circuited with a single
 * {@code error} + {@code done(failed)} pair.
 *
 * <p>Scoped to {@code /v1/conversation/run} streams.
 */
@Service
public class SystemPromptLeakOutputFilter {

  private static final List<Pattern> SUSPICIOUS =
      List.of(
          Pattern.compile("(?i)\\[USER_SKILL_BEGIN"),
          Pattern.compile("(?i)\\[SECURITY\\s*[—-]+\\s*non-negotiable\\]"),
          Pattern.compile("(?i)\\bagent\\.system|\\bbase\\.system|\\bguard\\.system"),
          Pattern.compile(
              "(?i)\\b(reveal|dump|print|repeat|paraphrase|leak)\\s+(the\\s+)?(system|prompt|rules)\\b"),
          Pattern.compile("(?i)\\bskill\\.lang\\."),
          Pattern.compile("系统提示词|系统提示|内部指令|加载了哪些\\s*skill"));

  private final ObjectMapper mapper;

  public SystemPromptLeakOutputFilter(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  public Flux<ServerSentEvent<String>> guard(Flux<ServerSentEvent<String>> source) {
    return source.switchOnFirst(
        (signal, src) ->
            src.concatMap(
                sse -> {
                  if (!SseEvents.DELTA.equals(sse.event())) {
                    return Flux.just(sse);
                  }
                  String text = extractDeltaText(sse.data());
                  if (text != null && containsLeak(text)) {
                    return Flux.just(blocked(), done());
                  }
                  return Flux.just(sse);
                }));
  }

  private static boolean containsLeak(String text) {
    for (Pattern p : SUSPICIOUS) {
      if (p.matcher(text).find()) return true;
    }
    return false;
  }

  private String extractDeltaText(String data) {
    try {
      JsonNode node = mapper.readTree(data);
      JsonNode t = node.get("text");
      return t == null ? null : t.asText();
    } catch (JsonProcessingException e) {
      return data;
    }
  }

  private ServerSentEvent<String> blocked() {
    return event(
        SseEvents.ERROR,
        Map.of(
            "code", ErrorCodes.SYSTEM_PROMPT_LEAK, "message", "Output blocked by safety policy"));
  }

  private ServerSentEvent<String> done() {
    return event(SseEvents.DONE, Map.of("reason", "failed"));
  }

  private ServerSentEvent<String> event(String name, Object payload) {
    try {
      return ServerSentEvent.<String>builder()
          .event(name)
          .data(mapper.writeValueAsString(payload))
          .build();
    } catch (Exception e) {
      return ServerSentEvent.<String>builder().event(name).data("{}").build();
    }
  }
}
