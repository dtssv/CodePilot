package io.codepilot.mcp;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;

/** Plugin self-update DTOs (see docs/05-接口文档.md §10.5). */
public final class PluginUpdate {

  private PluginUpdate() {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Manifest(
      String version,
      String channel,
      String minIdeBuild,
      String maxIdeBuild,
      boolean rolledOut,
      String pinTo,
      List<Artifact> artifacts,
      String changelogUrl,
      String checksumAlgo,
      long ttlSeconds,
      Instant publishedAt) {}

  public record Artifact(
      String kind, String url, long size, String sha256, String signature, List<String> covers) {}

  /** What we read from the {@code plugin_releases.manifest_json} blob. */
  public record StoredManifest(JsonNode manifest, int rolloutPercent, String pinTo) {}

  public record Changelog(JsonNode added, JsonNode changed, JsonNode fixed, JsonNode security) {}
}