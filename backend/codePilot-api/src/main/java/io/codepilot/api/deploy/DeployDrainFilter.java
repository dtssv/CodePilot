package io.codepilot.api.deploy;

import io.codepilot.core.deploy.DeployDrainService;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * While the pod is draining (rolling deploy / shutdown), reject new conversation runs so clients
 * fail fast and can retry on another replica.
 */
@Component
@Order(40)
public class DeployDrainFilter implements WebFilter {

  private final DeployDrainService drainService;

  public DeployDrainFilter(DeployDrainService drainService) {
    this.drainService = drainService;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    if (!drainService.shouldRejectNewRuns()) {
      return chain.filter(exchange);
    }
    String path = exchange.getRequest().getPath().value();
    if (!path.contains("/conversation/run") && !path.contains("/conversation/resume")) {
      return chain.filter(exchange);
    }
    exchange.getResponse().setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
    exchange.getResponse().getHeaders().add("Retry-After", "60");
    exchange.getResponse().getHeaders().add("X-Drain-Reason", "deploy-draining");
    return exchange.getResponse().setComplete();
  }
}
