package io.codepilot.mcp;

import com.fasterxml.jackson.databind.JsonNode;
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

/**
 * Skill marketplace read-only API.
 * system Skill: manifest redacted to safe summary; body NEVER downloadable.
 * user Skill: full manifest and download available with signature verification.
 */
@RestController
@RequestMapping(value = "/v1/skills", produces = MediaType.APPLICATION_JSON_VALUE)
public class SkillController {

    private final McpRepository repo;
    private final SignatureService signatureService;

    public SkillController(McpRepository repo, SignatureService signatureService) {
        this.repo = repo;
        this.signatureService = signatureService;
    }

    @GetMapping("/packages")
    public ApiResponse<McpController.PageResponse> list(
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String q,
            @RequestParam(defaultValue = "1") @Min(1) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        int offset = (page - 1) * size;
        var items = repo.list("skill", q, size, offset);
        return ApiResponse.ok(new McpController.PageResponse(items.size(), page, size, items));
    }

    @GetMapping("/packages/{slug}")
    public ApiResponse<McpPackage> details(@PathVariable String slug) {
        return repo.findBySlug(slug)
                .map(ApiResponse::ok)
                .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "Skill package not found"));
    }

    @GetMapping("/packages/{slug}/versions/{version}/manifest")
    public ApiResponse<JsonNode> manifest(
            @PathVariable String slug, @PathVariable String version) {
        var ver = repo.findVersion(slug, version)
                .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "Version not found"));
        JsonNode manifest = ver.manifest();
        if (isSystem(manifest)) {
            manifest = repo.redactManifestForSystem(manifest);
        }
        return ApiResponse.ok(manifest);
    }

    @GetMapping("/packages/{slug}/versions/{version}/download")
    public ResponseEntity<ApiResponse<McpController.DownloadInfo>> download(
            @PathVariable String slug, @PathVariable String version) {
        var ver = repo.findVersion(slug, version)
                .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "Version not found"));

        if (isSystem(ver.manifest())) {
            throw new CodePilotException(ErrorCodes.FORBIDDEN,
                    "System Skills are not downloadable — managed by the backend");
        }

        // Verify signature before allowing download
        if (ver.signature() != null && !ver.signature().isBlank()) {
            boolean valid = signatureService.verifyOfficialSignature(
                    ver.sha256(), ver.manifest().toString(), ver.signature());
            if (!valid) {
                throw new CodePilotException(ErrorCodes.FORBIDDEN,
                        "Skill package signature verification failed");
            }
        }

        return ResponseEntity.ok(ApiResponse.ok(
                new McpController.DownloadInfo(
                        ver.downloadUrl(), ver.sha256(), ver.signature(),
                        ver.signedAt().toEpochMilli())));
    }

    private boolean isSystem(JsonNode manifest) {
        if (manifest == null) return false;
        var source = manifest.get("source");
        return source != null && "system".equalsIgnoreCase(source.asText());
    }
}