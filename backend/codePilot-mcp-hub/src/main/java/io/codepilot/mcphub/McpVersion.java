package io.codepilot.mcphub;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.Map;

/**
 * Represents a specific version of an MCP/Skill package.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record McpVersion(
    String id,
    String packageId,
    String version,
    /** The manifest JSON (safe subset; systemPrompt/examples excluded for system skills). */
    Map<String, Object> manifest,
    String downloadUrl,
    String sha256,
    String signature,
    Instant signedAt) {}