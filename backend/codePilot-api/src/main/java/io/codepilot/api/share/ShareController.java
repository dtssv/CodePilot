package io.codepilot.api.share;

import io.codepilot.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;
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

  private final Path storageDir;

  public ShareController(@Value("${codepilot.share.storage-dir:${java.io.tmpdir}/codepilot-share}") String storageDir) {
    this.storageDir = Path.of(storageDir);
  }

  @Operation(summary = "Create a shareable conversation snapshot")
  @PostMapping(value = "/create", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Object>> create(@RequestBody @Valid CreateShareRequest req) throws Exception {
    Files.createDirectories(storageDir);
    String id = UUID.randomUUID().toString();
    Instant expiresAt = Instant.now().plus(req.expireDays() != null ? req.expireDays() : 7, ChronoUnit.DAYS);
    String redacted = redact(req.content());
    String body = """
        {
          "id": "%s",
          "title": %s,
          "format": "%s",
          "createdAt": "%s",
          "expiresAt": "%s",
          "content": %s
        }
        """.formatted(
        id,
        json(req.title() != null ? req.title() : "CodePilot Share"),
        req.format() != null ? req.format() : "markdown",
        Instant.now(),
        expiresAt,
        json(redacted));
    Files.writeString(storageDir.resolve(id + ".json"), body);
    return ApiResponse.ok(Map.of(
        "shareId", id,
        "url", "/v1/share/" + id,
        "expiresAt", expiresAt.toString()));
  }

  @Operation(summary = "Get a shared conversation snapshot")
  @GetMapping("/{id}")
  public ApiResponse<Map<String, Object>> get(@PathVariable String id) throws Exception {
    Path path = storageDir.resolve(id + ".json").normalize();
    if (!path.startsWith(storageDir) || !Files.exists(path)) {
      return ApiResponse.ok(Map.of("found", false));
    }
    return ApiResponse.ok(Map.of("found", true, "raw", Files.readString(path)));
  }

  @Operation(summary = "Revoke a share")
  @DeleteMapping("/{id}")
  public ApiResponse<Map<String, Object>> revoke(@PathVariable String id) throws Exception {
    Path path = storageDir.resolve(id + ".json").normalize();
    boolean deleted = path.startsWith(storageDir) && Files.deleteIfExists(path);
    return ApiResponse.ok(Map.of("deleted", deleted));
  }

  private static String redact(String content) {
    if (content == null) return "";
    return content
        .replaceAll("(?i)(api[_-]?key|token|secret)\\s*[:=]\\s*[^\\s`]+", "$1=[REDACTED]")
        .replaceAll("(?i)bearer\\s+[A-Za-z0-9._\\-]{20,}", "Bearer [REDACTED]");
  }

  private static String json(String s) {
    return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
  }

  public record CreateShareRequest(
      String title,
      String format,
      @NotBlank String content,
      Integer expireDays) {}
}
