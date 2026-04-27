package io.codepilot.mcphub;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * Represents an MCP/Skill package in the marketplace.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record McpPackage(
    String id,
    String slug,
    String name,
    /** "mcp" or "skill". */
    String type,
    String author,
    String latestVersion,
    String description,
    String homepageUrl,
    String changelogUrl,
    boolean deprecated,
    Instant createdAt,
    Instant updatedAt) {}