package io.codepilot.gateway.util;

import java.nio.charset.StandardCharsets;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.core.io.buffer.DefaultDataBufferFactory;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpRequestDecorator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Wraps a {@link ServerHttpRequest} so its body can be safely read multiple times. Used for
 * signature verification + downstream parsing on the same request. Maximum body size is enforced.
 */
public final class CachedBodyServerHttpRequestDecorator extends ServerHttpRequestDecorator {

  private final byte[] cachedBody;

  private CachedBodyServerHttpRequestDecorator(ServerHttpRequest delegate, byte[] cachedBody) {
    super(delegate);
    this.cachedBody = cachedBody;
  }

  /**
   * Reads the body fully into memory once (capped at {@code maxBytes}) and returns a cached-body
   * decorator. The buffered bytes are also returned via the second tuple so callers can hash /
   * sign without re-reading.
   */
  public static Mono<Wrapped> wrap(ServerHttpRequest delegate, int maxBytes) {
    return DataBufferUtils.join(delegate.getBody(), maxBytes)
        .defaultIfEmpty(DefaultDataBufferFactory.sharedInstance.wrap(new byte[0]))
        .map(
            joined -> {
              byte[] bytes = new byte[joined.readableByteCount()];
              joined.read(bytes);
              DataBufferUtils.release(joined);
              ServerHttpRequest cached = new CachedBodyServerHttpRequestDecorator(delegate, bytes);
              return new Wrapped(cached, bytes);
            });
  }

  @Override
  public Flux<DataBuffer> getBody() {
    return Flux.just(DefaultDataBufferFactory.sharedInstance.wrap(cachedBody));
  }

  public String bodyAsString() {
    return new String(cachedBody, StandardCharsets.UTF_8);
  }

  public record Wrapped(ServerHttpRequest request, byte[] body) {
    public String bodyAsString() {
      return new String(body, StandardCharsets.UTF_8);
    }
  }
}