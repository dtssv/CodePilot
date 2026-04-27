package io.codepilot.gateway.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.ApiResponse;
import java.nio.charset.StandardCharsets;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * Helper for writing a uniform JSON error envelope (no internal exception text leakage). Used by
 * web filters that need to short-circuit before reaching the controller layer.
 */
public final class WebErrors {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private WebErrors() {}

  public static Mono<Void> write(
      ServerWebExchange exchange, int code, String userFacingMessage, int httpStatus) {
    ServerHttpResponse response = exchange.getResponse();
    response.setStatusCode(HttpStatus.valueOf(httpStatus));
    response.getHeaders().setContentType(MediaType.APPLICATION_JSON);

    byte[] payload;
    try {
      payload = MAPPER.writeValueAsBytes(ApiResponse.of(code, userFacingMessage));
    } catch (Exception e) {
      payload = ("{\"code\":" + code + ",\"message\":\"" + userFacingMessage + "\"}")
              .getBytes(StandardCharsets.UTF_8);
    }
    DataBuffer buffer = response.bufferFactory().wrap(payload);
    return response.writeWith(Mono.just(buffer));
  }
}