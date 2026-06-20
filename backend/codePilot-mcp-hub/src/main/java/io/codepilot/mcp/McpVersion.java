package io.codepilot.mcp;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

/**
 * Safe per-version record. For {@code system} packages, the manifest is filtered server-side so
 * only {@code triggersBrief} / {@code permissionsBrief} / {@code audit} reach the client.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record McpVersion(
    String packageSlug,
    String version,
    JsonNode manifest,
    String downloadUrl,
    String sha256,
    String signature,
    Instant signedAt) {}
