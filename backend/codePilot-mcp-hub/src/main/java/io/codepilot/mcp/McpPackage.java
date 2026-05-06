package io.codepilot.mcp;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

/** Safe summary of a marketplace package. The {@code manifest} NEVER contains systemPrompt bodies. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record McpPackage(
    String id,
    String slug,
    String name,
    String type,
    String author,
    String latestVersion,
    String description,
    String homepageUrl,
    String changelogUrl,
    boolean deprecated,
    Instant updatedAt) {}