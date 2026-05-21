package io.codepilot.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Skill marketplace read-only API.
 *
 * <p>Listed Skills are expected to be installable in the IDE. When {@code download_url} is blank,
 * artifacts are synthesized from classpath {@code skills/*.yaml} in {@code codePilot-core}.
 *
 * <p>Packages marked {@code source=system} in the DB stay server-side-only unless the same YAML
 * exists on the classpath (demo / official bundles).
 */
@RestController
@RequestMapping(value = "/v1/skills", produces = MediaType.APPLICATION_JSON_VALUE)
public class SkillController {

    private final McpRepository repo;
    private final SignatureService signatureService;
    private final SkillClasspathArchiveService archiveService;

    public SkillController(
            McpRepository repo,
            SignatureService signatureService,
            SkillClasspathArchiveService archiveService) {
        this.repo = repo;
        this.signatureService = signatureService;
        this.archiveService = archiveService;
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

    @GetMapping("/packages/{slug:.+}")
    public ApiResponse<McpPackage> details(@PathVariable String slug) {
        return repo.findBySlug(slug)
                .map(ApiResponse::ok)
                .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "Skill package not found"));
    }

    @GetMapping("/packages/{slug:.+}/versions/{version}/manifest")
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

    @GetMapping("/packages/{slug:.+}/versions/{version}/download")
    public ResponseEntity<ApiResponse<McpController.DownloadInfo>> download(
            @PathVariable String slug, @PathVariable String version) {
        var ver = repo.findVersion(slug, version)
                .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "Version not found"));

        String explicitUrl = ver.downloadUrl();
        if (explicitUrl != null && !explicitUrl.isBlank()) {
            if (isSystem(ver.manifest())) {
                throw new CodePilotException(
                        ErrorCodes.FORBIDDEN,
                        "This package is marked system-only and has no downloadable artifact configured");
            }
            verifySignatureWhenPresent(ver);
            long signedMs = ver.signedAt() != null ? ver.signedAt().toEpochMilli() : 0L;
            return ResponseEntity.ok(ApiResponse.ok(
                    new McpController.DownloadInfo(
                            explicitUrl, ver.sha256(), ver.signature(), signedMs)));
        }

        // Bundled classpath skill (ZIP with skill.yaml)
        if (!archiveService.hasClasspathYaml(slug)) {
            if (isSystem(ver.manifest())) {
                throw new CodePilotException(
                        ErrorCodes.FORBIDDEN,
                        "Skill is server-managed and no local install artifact is published");
            }
            throw new CodePilotException(ErrorCodes.NOT_FOUND, "Skill package has no download artifact");
        }

        byte[] zip = archiveService.zipBytes(slug);
        String sha = archiveService.sha256Hex(zip);
        String relative = "/v1/skills/packages/" + slug + "/versions/" + version + "/archive";
        long signedMs = ver.signedAt() != null ? ver.signedAt().toEpochMilli() : 0L;
        return ResponseEntity.ok(ApiResponse.ok(
                new McpController.DownloadInfo(relative, sha, null, signedMs)));
    }

    /** Raw ZIP artifact (single {@code skill.yaml}) for IDE installer + SHA verification. */
    @GetMapping(
            value = "/packages/{slug:.+}/versions/{version}/archive",
            produces = "application/zip")
    public ResponseEntity<byte[]> downloadArchive(@PathVariable String slug, @PathVariable String version) {
        repo.findVersion(slug, version)
                .orElseThrow(() -> new CodePilotException(ErrorCodes.NOT_FOUND, "Version not found"));
        if (!archiveService.hasClasspathYaml(slug)) {
            throw new CodePilotException(ErrorCodes.NOT_FOUND, "No bundled archive for slug: " + slug);
        }
        byte[] zip = archiveService.zipBytes(slug);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/zip")
                .header(HttpHeaders.CONTENT_LENGTH, String.valueOf(zip.length))
                .body(zip);
    }

    private void verifySignatureWhenPresent(McpVersion ver) {
        if (ver.signature() != null && !ver.signature().isBlank()) {
            boolean valid = signatureService.verifyOfficialSignature(
                    ver.sha256(), ver.manifest().toString(), ver.signature());
            if (!valid) {
                throw new CodePilotException(
                        ErrorCodes.FORBIDDEN, "Skill package signature verification failed");
            }
        }
    }

    private boolean isSystem(JsonNode manifest) {
        if (manifest == null) {
            return false;
        }
        var source = manifest.get("source");
        return source != null && "system".equalsIgnoreCase(source.asText());
    }
}
