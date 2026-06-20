package io.codepilot.api.admin;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DefaultDataBufferFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Serves the Admin Dashboard SPA page at /admin. The HTML/JS is bundled as a classpath resource
 * (admin/index.html). This controller reads it and returns it as HTML.
 */
@RestController
public class AdminPageController {

  @GetMapping(value = "/admin", produces = MediaType.TEXT_HTML_VALUE)
  public Mono<ResponseEntity<Flux<DataBuffer>>> adminPage() {
    return Mono.fromSupplier(
        () -> {
          try {
            ClassPathResource resource = new ClassPathResource("admin/index.html");
            try (InputStream is = resource.getInputStream()) {
              byte[] bytes = is.readAllBytes();
              DataBuffer buffer = new DefaultDataBufferFactory().wrap(bytes);
              return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(Flux.just(buffer));
            }
          } catch (Exception e) {
            DataBuffer buffer =
                new DefaultDataBufferFactory()
                    .wrap(
                        "<html><body><h2>Admin page not found</h2></body></html>"
                            .getBytes(StandardCharsets.UTF_8));
            return ResponseEntity.status(404)
                .contentType(MediaType.TEXT_HTML)
                .body(Flux.just(buffer));
          }
        });
  }
}
