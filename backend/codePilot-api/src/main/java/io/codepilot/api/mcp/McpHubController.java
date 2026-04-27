package io.codepilot.api.mcp;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.mcphub.InstallRequest;
import io.codepilot.mcphub.McpHubService;
import io.codepilot.mcphub.McpPackage;
import io.codepilot.mcphub.McpVersion;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * REST controller for the MCP/Skill marketplace hub.
 *
 * <ul>
 *   <li>{@code GET    /v1/mcp/packages}                     — search/list packages</li>
 *   <li>{@code GET    /v1/mcp/packages/{slug}}              — package details</li>
 *   <li>{@code GET    /v1/mcp/packages/{slug}/versions}     — all versions</li>
 *   <li>{@code GET    /v1/mcp/packages/{slug}/versions/{v}} — specific version manifest</li>
 *   <li>{@code POST   /v1/mcp/install}                      — record install</li>
 *   <li>{@code POST   /v1/mcp/uninstall}                    — record uninstall</li>
 *   <li>{@code POST   /v1/mcp/update}                       — record update</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/mcp")
public class McpHubController {

  private static final String USER_ID_HEADER = "X-CodePilot-User-Id";

  private final McpHubService hubService;

  public McpHubController(McpHubService hubService) {
    this.hubService = hubService;
  }

  /** GET /v1/mcp/packages — search/list packages. */
  @GetMapping("/packages")
  public Mono<ResponseEntity<ApiResponse<List<McpPackage>>>> searchPackages(
      @RequestParam(required = false) String type,
      @RequestParam(required = false) String q,
      @RequestParam(defaultValue = "0") int page,
      @RequestParam(defaultValue = "20") int size) {
    return hubService.searchPackages(type, q, page, size)
        .map(list -> ResponseEntity.ok(ApiResponse.ok(list)));
  }

  /** GET /v1/mcp/packages/{slug} — package details. */
  @GetMapping("/packages/{slug}")
  public Mono<ResponseEntity<ApiResponse<McpPackage>>> getPackage(@PathVariable String slug) {
    return hubService.getPackageBySlug(slug)
        .map(pkg -> ResponseEntity.ok(ApiResponse.ok(pkg)))
        .defaultIfEmpty(ResponseEntity.notFound().build());
  }

  /** GET /v1/mcp/packages/{slug}/versions — all versions. */
  @GetMapping("/packages/{slug}/versions")
  public Mono<ResponseEntity<ApiResponse<List<McpVersion>>>> getVersions(@PathVariable String slug) {
    return hubService.getVersions(slug)
        .map(list -> ResponseEntity.ok(ApiResponse.ok(list)));
  }

  /** GET /v1/mcp/packages/{slug}/versions/{version} — specific version manifest. */
  @GetMapping("/packages/{slug}/versions/{version}")
  public Mono<ResponseEntity<ApiResponse<McpVersion>>> getVersion(
      @PathVariable String slug, @PathVariable String version) {
    return hubService.getVersion(slug, version)
        .map(v -> ResponseEntity.ok(ApiResponse.ok(v)))
        .defaultIfEmpty(ResponseEntity.notFound().build());
  }

  /** POST /v1/mcp/install — record install. */
  @PostMapping("/install")
  public Mono<ResponseEntity<ApiResponse<Void>>> install(
      @RequestHeader(USER_ID_HEADER) String userId,
      @Valid @RequestBody InstallRequest req) {
    return hubService.install(userId, req)
        .thenReturn(ResponseEntity.ok(ApiResponse.ok(null)));
  }

  /** POST /v1/mcp/uninstall — record uninstall. */
  @PostMapping("/uninstall")
  public Mono<ResponseEntity<ApiResponse<Void>>> uninstall(
      @RequestHeader(USER_ID_HEADER) String userId,
      @Valid @RequestBody InstallRequest req) {
    return hubService.uninstall(userId, req)
        .thenReturn(ResponseEntity.ok(ApiResponse.ok(null)));
  }

  /** POST /v1/mcp/update — record update. */
  @PostMapping("/update")
  public Mono<ResponseEntity<ApiResponse<Void>>> update(
      @RequestHeader(USER_ID_HEADER) String userId,
      @Valid @RequestBody InstallRequest req) {
    return hubService.update(userId, req)
        .thenReturn(ResponseEntity.ok(ApiResponse.ok(null)));
  }
}