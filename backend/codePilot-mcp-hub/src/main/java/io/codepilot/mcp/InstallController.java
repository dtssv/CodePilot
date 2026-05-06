package io.codepilot.mcp;

import io.codepilot.common.api.ApiResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Metadata-only install tracking. Downloads and Skill bodies are never persisted server-side; the
 * plugin installs to the local filesystem. The backend only keeps enough to show "what this user
 * has" for re-installs and audit.
 */
@RestController
@RequestMapping(
    value = "/v1/mcp",
    produces = MediaType.APPLICATION_JSON_VALUE,
    consumes = MediaType.APPLICATION_JSON_VALUE)
public class InstallController {

  private final InstallRecordRepository repo;

  public InstallController(InstallRecordRepository repo) {
    this.repo = repo;
  }

  @PostMapping("/install")
  public ApiResponse<Result> install(
      @RequestBody @Valid InstallRequest req,
      @RequestHeader(value = "X-CodePilot-User-Id", required = false) String userIdHeader) {
    String userId = resolveUser(userIdHeader);
    int n = repo.recordInstall(userId, req.slug(), req.version(), req.scope(), req.source());
    return ApiResponse.ok(new Result(n == 1));
  }

  @PostMapping("/uninstall")
  public ApiResponse<Result> uninstall(
      @RequestBody @Valid InstallRequest req,
      @RequestHeader(value = "X-CodePilot-User-Id", required = false) String userIdHeader) {
    String userId = resolveUser(userIdHeader);
    int n = repo.recordUninstall(userId, req.slug(), req.version(), req.scope(), req.source());
    return ApiResponse.ok(new Result(n == 1));
  }

  private String resolveUser(String header) {
    // Real auth-aware lookup comes in once SecurityContext holds the principal; M6/R2 accepts the
    // header as a convenience for the plugin. The stored user_id is opaque to callers.
    if (header == null || header.isBlank()) {
      return "00000000-0000-0000-0000-00000000deva";
    }
    return header;
  }

  public record InstallRequest(
      @NotBlank String slug,
      @NotBlank String version,
      @NotBlank String scope, // project | global
      @NotBlank String source // official | third-party | local | builtin-ide
      ) {}

  public record Result(boolean ok) {}
}