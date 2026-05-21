package io.codepilot.api.conversation;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.run.ConversationRunAdmissionService;
import io.codepilot.core.run.ConversationRunAdmissionService.AdmissionStatus;
import io.codepilot.core.run.ConversationRunProperties;
import java.nio.charset.StandardCharsets;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Fast reject for agent {@code POST /v1/conversation/run} when admission counters are full (read-only
 * check). The authoritative increment happens in {@link ConversationQueuedOrchestrator}.
 */
@Component
@Order(42)
public class ConversationRunAdmissionFilter implements WebFilter {

  private final ConversationRunStore store;
  private final ConversationRunAdmissionService admission;
  private final ConversationRunProperties queueProperties;
  private final ObjectMapper mapper;

  public ConversationRunAdmissionFilter(
      ConversationRunStore store,
      ConversationRunAdmissionService admission,
      ConversationRunProperties queueProperties,
      ObjectMapper mapper) {
    this.store = store;
    this.admission = admission;
    this.queueProperties = queueProperties;
    this.mapper = mapper;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getPath().value();
    if (!path.endsWith("/v1/conversation/run")
        || !"POST".equalsIgnoreCase(exchange.getRequest().getMethod().name())) {
      return chain.filter(exchange);
    }
    if (!store.isDbBacked()
        || !admission.isEnabled()
        || "false".equalsIgnoreCase(queueProperties.getEnabled())) {
      return chain.filter(exchange);
    }
    String mode = exchange.getRequest().getHeaders().getFirst("X-Conversation-Mode");
    if (mode != null && !mode.isBlank() && !ConversationMode.AGENT.name().equalsIgnoreCase(mode)) {
      return chain.filter(exchange);
    }
    String userId = exchange.getRequest().getHeaders().getFirst("X-User-Id");
    if (userId == null || userId.isBlank()) {
      userId = "dev-user";
    }
    return admission
        .status(userId)
        .flatMap(
            status -> {
              if (status.admit()) {
                return chain.filter(exchange);
              }
              return writeRejected(exchange, status);
            });
  }

  private Mono<Void> writeRejected(ServerWebExchange exchange, AdmissionStatus status) {
    exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
    exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
    int retry = status.retryAfterSec() > 0 ? status.retryAfterSec() : admission.retryAfterSeconds();
    exchange.getResponse().getHeaders().add("Retry-After", String.valueOf(retry));
    exchange.getResponse().getHeaders().add("X-RateLimit-Type", "agent-queue");
    exchange.getResponse().getHeaders().add("X-RateLimit-Reason", "queue-full");
    String body;
    try {
      body =
          mapper.writeValueAsString(
              java.util.Map.of(
                  "code",
                  ErrorCodes.QUEUE_FULL,
                  "message",
                  "Agent queue is at capacity; retry after " + retry + " seconds"));
    } catch (Exception e) {
      body = "{\"code\":42902,\"message\":\"queue full\"}";
    }
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    return exchange.getResponse().writeWith(Mono.just(exchange.getResponse().bufferFactory().wrap(bytes)));
  }
}
