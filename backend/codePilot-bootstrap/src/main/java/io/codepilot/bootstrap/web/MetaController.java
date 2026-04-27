package io.codepilot.bootstrap.web;

import io.codepilot.common.api.ApiResponse;
import java.util.Map;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Lightweight meta endpoints — useful even before the rest of the API is wired.
 */
@RestController
@RequestMapping(value = "/v1", produces = MediaType.APPLICATION_JSON_VALUE)
public class MetaController {

    private final BuildProperties build;

    public MetaController(BuildProperties build) {
        this.build = build;
    }

    @GetMapping("/version")
    public ApiResponse<Map<String, String>> version() {
        return ApiResponse.ok(
                Map.of(
                        "name", build.getName(),
                        "version", build.getVersion(),
                        "buildTime", build.getTime().toString()));
    }
}