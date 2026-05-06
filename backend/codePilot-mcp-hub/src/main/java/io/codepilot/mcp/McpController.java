package io.codepilot.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Read-only marketplace API. system packages are summarized; download is forbidden for system. */
@RestController
@RequestMapping(value = "/v1/mcp", produces = MediaType.APPLICATION_JSON_VALUE)
public class McpController {

  private final McpRepository repo;

  public McpController(McpRepository repo) {
    this.repo = repo;
  }

  @GetMapping("/packages")
  public ApiResponse<PageResponse> list(
      @RequestParam(required = false) String type,
      @RequestParam(required = false) String q,
      @RequestParam(defaultValue = "1") @Min(1) int page,
      @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
    int offset = (page - 1) * size;
    var items = repo.list(type, q, size, offset);
    return ApiResponse.ok(new PageResponse(items.size(), page, size, items));
  }

  @GetMapping("/packages/{slug}")
  public ApiResponse<McpPackage> details(@PathVariable String slug) {
    return repo.findBySlug(slug)
        .map(ApiResponse::ok)
        .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "package not found"));
  }

  @GetMapping("/packages/{slug}/versions/{version}/manifest")
  public ApiResponse<JsonNode> manifest(
      @PathVariable String slug, @PathVariable String version) {
    var ver =
        repo.findVersion(slug, version)
            .orElseThrow(
                () -> new CodePilotException(ErrorCodes.NOT_FOUND, "version not found"));
    JsonNode manifest = ver.manifest();
    if (isSystem(manifest)) {
      manifest = repo.redactManifestForSystem(manifest);
    }
    return ApiResponse.ok(manifest);
  }

  @GetMapping("/packages/{slug}/versions/{version}/download")
  public ResponseEntity<ApiResponse<DownloadInfo>> download(
      @PathVariable String slug, @PathVariable String version) {
    var ver =
        repo.findVersion(slug, version)
            .orElseThrow(
                () -> new CodePilotException(ErrorCodes.NOT_FOUND, "version not found"));
    if (isSystem(ver.manifest())) {
      throw new CodePilotException(
          ErrorCodes.FORBIDDEN, "system packages are not downloadable");
    }
    return ResponseEntity.ok(
        ApiResponse.ok(
            new DownloadInfo(ver.downloadUrl(), ver.sha256(), ver.signature(), ver.signedAt().toEpochMilli())));
  }

  private boolean isSystem(JsonNode manifest) {
    if (manifest == null) return false;
    JsonNode source = manifest.get("source");
    return source != null && "system".equalsIgnoreCase(source.asText());
  }

  // -- DTOs --

  public record PageResponse(int total, int page, int size, java.util.List<McpPackage> items) {}

  public record DownloadInfo(String url, String sha256, String signature, long signedAtMs) {}
}