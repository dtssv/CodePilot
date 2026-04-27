package io.codepilot.gateway.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.web.WebProperties;
import org.springframework.boot.autoconfigure.web.reactive.error.AbstractErrorWebExceptionHandler;
import org.springframework.boot.web.reactive.error.ErrorAttributes;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.codec.Encoder;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerCodecConfigurer;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.server.RequestPredicates;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;

/**
 * Maps unhandled errors to the unified JSON envelope ({@link ApiResponse}) instead of Spring's
 * default Whitelabel page. Order {@code -2} ensures we run before the framework defaults.
 */
@Component
@Order(-2)
public class GlobalErrorWebExceptionHandler extends AbstractErrorWebExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalErrorWebExceptionHandler.class);

  private final ObjectMapper mapper;

  public GlobalErrorWebExceptionHandler(
      ErrorAttributes errorAttributes,
      ApplicationContext applicationContext,
      ServerCodecConfigurer configurer,
      ObjectMapper mapper) {
    super(errorAttributes, new WebProperties.Resources(), applicationContext);
    this.setMessageWriters(configurer.getWriters());
    this.setMessageReaders(configurer.getReaders());
    this.mapper = mapper;
  }

  @Override
  protected RouterFunction<ServerResponse> getRoutingFunction(ErrorAttributes errorAttributes) {
    return RouterFunctions.route(RequestPredicates.all(), this::render);
  }

  private Mono<ServerResponse> render(ServerRequest request) {
    Throwable ex = getError(request);
    int code;
    int http;
    String message;
    if (ex instanceof CodePilotException cpe) {
      code = cpe.code();
      message = cpe.getMessage();
      http = mapHttp(code);
    } else if (ex instanceof ResponseStatusException rse) {
      http = rse.getStatusCode().value();
      code = http * 100 + 1;
      message = rse.getReason() != null ? rse.getReason() : rse.getStatusCode().toString();
    } else {
      log.error("Unhandled exception while serving {}", request.path(), ex);
      http = 500;
      code = ErrorCodes.INTERNAL;
      message = "Internal error";
    }

    return ServerResponse.status(HttpStatus.valueOf(http))
        .contentType(MediaType.APPLICATION_JSON)
        .body(BodyInserters.fromValue(ApiResponse.of(code, message)));
  }

  private int mapHttp(int code) {
    return switch (code) {
      case ErrorCodes.BAD_REQUEST -> 400;
      case ErrorCodes.UNAUTHORIZED -> 401;
      case ErrorCodes.FORBIDDEN -> 403;
      case ErrorCodes.NOT_FOUND -> 404;
      case ErrorCodes.RATE_LIMITED -> 429;
      case ErrorCodes.SECURITY_BLOCKED, ErrorCodes.SYSTEM_PROMPT_LEAK, ErrorCodes.USER_SKILL_INVALID ->
          451;
      case ErrorCodes.UPSTREAM_MODEL -> 502;
      default -> 500;
    };
  }
}