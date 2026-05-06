package io.codepilot.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.mcp.PluginUpdate.Artifact;
import io.codepilot.mcp.PluginUpdate.Manifest;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class PluginReleaseRepository {

  private final NamedParameterJdbcTemplate jdbc;
  private final ObjectMapper mapper;

  public PluginReleaseRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
  }

  /** Returns the highest-version release for the given channel & ide build. */
  public Optional<Manifest> latestForChannel(String channel, String ideBuild, String deviceId) {
    String sql =
        """
        SELECT version, min_ide_build, max_ide_build, manifest_json, rollout_percent, pin_to,
               published_at
          FROM plugin_releases
         WHERE channel = :channel
           AND (max_ide_build IS NULL OR :ide <= max_ide_build)
           AND :ide >= min_ide_build
         ORDER BY published_at DESC
         LIMIT 1
        """;
    var params = new MapSqlParameterSource()
        .addValue("channel", channel)
        .addValue("ide", ideBuild);
    return jdbc.query(
            sql,
            params,
            (rs, i) -> {
              JsonNode manifestJson = readJson(rs.getString("manifest_json"));
              List<Artifact> artifacts = readArtifacts(manifestJson);
              JsonNode changelogUrlNode = manifestJson != null ? manifestJson.get("changelogUrl") : null;
              int rollout = rs.getInt("rollout_percent");
              String pinTo = rs.getString("pin_to");
              boolean rolledOut = rolloutHits(deviceId, rollout);
              Instant published = rs.getTimestamp("published_at").toInstant();
              return new Manifest(
                  rs.getString("version"),
                  channel,
                  rs.getString("min_ide_build"),
                  rs.getString("max_ide_build"),
                  rolledOut,
                  pinTo,
                  artifacts,
                  changelogUrlNode == null ? null : changelogUrlNode.asText(),
                  "SHA-256",
                  900L,
                  published);
            })
        .stream()
        .findFirst();
  }

  private List<Artifact> readArtifacts(JsonNode manifest) {
    if (manifest == null) return List.of();
    JsonNode arr = manifest.get("artifacts");
    if (arr == null || !arr.isArray()) return List.of();
    return java.util.stream.StreamSupport.stream(arr.spliterator(), false)
        .map(
            n ->
                new Artifact(
                    text(n, "kind"),
                    text(n, "url"),
                    n.path("size").asLong(0),
                    text(n, "sha256"),
                    text(n, "signature"),
                    readArr(n, "covers")))
        .toList();
  }

  private static String text(JsonNode n, String f) {
    return n.has(f) ? n.get(f).asText() : null;
  }

  private static List<String> readArr(JsonNode n, String field) {
    JsonNode arr = n.get(field);
    if (arr == null || !arr.isArray()) return List.of();
    return java.util.stream.StreamSupport.stream(arr.spliterator(), false)
        .map(JsonNode::asText)
        .toList();
  }

  private static boolean rolloutHits(String deviceId, int percent) {
    if (percent >= 100) return true;
    if (percent <= 0 || deviceId == null) return false;
    int hash = Math.abs(deviceId.hashCode() % 100);
    return hash < percent;
  }

  private JsonNode readJson(String raw) {
    try {
      return raw == null ? null : mapper.readTree(raw);
    } catch (Exception e) {
      return null;
    }
  }
}