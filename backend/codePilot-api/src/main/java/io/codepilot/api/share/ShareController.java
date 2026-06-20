package io.codepilot.api.share;

import io.codepilot.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "share", description = "Conversation share/export links")
@RestController
@RequestMapping(value = "/v1/share", produces = MediaType.APPLICATION_JSON_VALUE)
public class ShareController {

  private final SharePersistenceStore store;
  private final String publicBaseUrl;

  public ShareController(
      SharePersistenceStore store,
      @Value("${codepilot.share.public-base-url:http://localhost:8080}") String publicBaseUrl) {
    this.store = store;
    this.publicBaseUrl =
        publicBaseUrl.endsWith("/")
            ? publicBaseUrl.substring(0, publicBaseUrl.length() - 1)
            : publicBaseUrl;
  }

  @Operation(summary = "Share persistence backend (db or file)")
  @GetMapping("/status")
  public ApiResponse<Map<String, Object>> status() {
    return ApiResponse.ok(Map.of("backend", store.isDbBacked() ? "db" : "file"));
  }

  @Operation(summary = "Create a shareable conversation snapshot")
  @PostMapping(value = "/create", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> create(@RequestBody @Valid CreateShareRequest req)
      throws Exception {
    String redacted = redact(req.content());
    SharePersistenceStore.ShareSnapshot snap =
        store.create(
            req.title(), req.format(), redacted, req.expireDays() != null ? req.expireDays() : 7);
    String path = "/v1/share/" + snap.id();
    return ApiResponse.ok(
        Map.of(
            "shareId",
            snap.id(),
            "url",
            publicBaseUrl + path,
            "viewPath",
            path,
            "expiresAt",
            snap.expiresAt().toString(),
            "backend",
            store.isDbBacked() ? "db" : "file"));
  }

  @Operation(summary = "Get a shared conversation snapshot")
  @GetMapping("/{id}")
  public ApiResponse<Map<String, Object>> get(@PathVariable String id) throws Exception {
    var opt = store.get(id);
    if (opt.isEmpty()) {
      return ApiResponse.ok(Map.of("found", false));
    }
    SharePersistenceStore.ShareSnapshot snap = opt.get();
    if (snap.revoked()) {
      return ApiResponse.ok(Map.of("found", false, "revoked", true));
    }
    if (snap.expiresAt().isBefore(Instant.now())) {
      return ApiResponse.ok(Map.of("found", false, "expired", true));
    }
    return ApiResponse.ok(
        Map.of(
            "found", true,
            "shareId", snap.id(),
            "title", snap.title(),
            "format", snap.format(),
            "content", snap.content(),
            "createdAt", snap.createdAt().toString(),
            "expiresAt", snap.expiresAt().toString(),
            "url", publicBaseUrl + "/v1/share/" + snap.id(),
            "backend", store.isDbBacked() ? "db" : "file"));
  }

  @Operation(summary = "Revoke a share")
  @DeleteMapping("/{id}")
  public ApiResponse<Map<String, Object>> revoke(@PathVariable String id) throws Exception {
    boolean deleted = store.revoke(id);
    return ApiResponse.ok(
        Map.of("deleted", deleted, "backend", store.isDbBacked() ? "db" : "file"));
  }

  private static String redact(String content) {
    if (content == null) return "";
    return content
        .replaceAll("(?i)(api[_-]?key|token|secret)\\s*[:=]\\s*[^\\s`]+", "$1=[REDACTED]")
        .replaceAll("(?i)bearer\\s+[A-Za-z0-9._\\-]{20,}", "Bearer [REDACTED]");
  }

  public record CreateShareRequest(
      String title, String format, @NotBlank String content, Integer expireDays) {}
}
