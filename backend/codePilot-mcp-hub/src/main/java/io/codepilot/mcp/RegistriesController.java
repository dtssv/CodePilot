package io.codepilot.mcp;

import io.codepilot.common.api.ApiResponse;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Lists Skill / MCP registries the plugin should consult.
 *
 * <p>The official registry is always the running CodePilot backend itself. Third-party registries
 * are configured by deployers via {@code codepilot.mcp.third-party-registries} (comma-separated
 * URLs); the plugin still verifies their signatures locally per docs §7.9.
 */
@RestController
@RequestMapping(value = "/v1/mcp", produces = MediaType.APPLICATION_JSON_VALUE)
public class RegistriesController {

  private final String thirdPartyRegistries;

  public RegistriesController(
      @Value("${codepilot.mcp.third-party-registries:}") String thirdPartyRegistries) {
    this.thirdPartyRegistries = thirdPartyRegistries == null ? "" : thirdPartyRegistries;
  }

  @GetMapping("/registries")
  public ApiResponse<RegistriesResponse> list() {
    Registry official =
        new Registry("official", "Official", "/v1/mcp/packages", true, null);
    List<Registry> thirdParty =
        thirdPartyRegistries.isBlank()
            ? List.of()
            : java.util.Arrays.stream(thirdPartyRegistries.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(url -> new Registry("third-party", url, url, false, "/.well-known/codePilot-registry.json"))
                .toList();
    return ApiResponse.ok(new RegistriesResponse(official, thirdParty));
  }

  public record RegistriesResponse(Registry official, List<Registry> thirdParty) {}

  public record Registry(
      String kind, String name, String packagesUrl, boolean trusted, String wellKnownPath) {}
}