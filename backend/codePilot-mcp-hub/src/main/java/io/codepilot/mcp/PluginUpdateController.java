package io.codepilot.mcp;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.mcp.PluginUpdate.Manifest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Plugin self-update endpoints. */
@RestController
@RequestMapping(value = "/v1/plugin", produces = MediaType.APPLICATION_JSON_VALUE)
public class PluginUpdateController {

  private final PluginReleaseRepository repo;

  public PluginUpdateController(PluginReleaseRepository repo) {
    this.repo = repo;
  }

  @GetMapping(value = "/manifest")
  public ApiResponse<Manifest> manifest(
      @RequestParam(defaultValue = "stable") String channel,
      @RequestParam @NotBlank String ideBuild,
      @RequestParam(required = false) String pluginVersion,
      @RequestParam(required = false) String deviceId) {
    var manifest =
        repo.latestForChannel(channel, ideBuild, deviceId)
            .orElseThrow(
                () -> new CodePilotException(ErrorCodes.NOT_FOUND, "no release for channel"));
    return ApiResponse.ok(manifest);
  }

  @PostMapping(value = "/update/report", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Void> report(@RequestBody @Valid ReportRequest req) {
    // The request-audit write point is added under M4.6; here we accept and log-trace.
    return ApiResponse.ok(null);
  }

  @GetMapping("/changelog/{version}")
  public ApiResponse<PluginUpdate.Changelog> changelog(@PathVariable String version) {
    // Placeholder: M4 wires the storage; for now return empty-groups so the plugin UI renders
    // gracefully.
    return ApiResponse.ok(new PluginUpdate.Changelog(null, null, null, null));
  }

  public record ReportRequest(
      @NotBlank String phase,
      String from,
      String to,
      String kind,
      Long durationMs,
      String errorCode,
      String fingerprint) {}
}
