package io.codepilot.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Timestamp;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/** Read-only access to {@code mcp_packages} and {@code mcp_versions}; no plaintext is exposed. */
@Repository
public class McpRepository {

  private static final List<String> SYSTEM_MANIFEST_SAFE_KEYS =
      List.of(
          "id",
          "version",
          "title",
          "scope",
          "owner",
          "triggersBrief",
          "permissionsBrief",
          "audit",
          "changelogUrl");

  private final NamedParameterJdbcTemplate jdbc;
  private final ObjectMapper mapper;

  public McpRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
  }

  public List<McpPackage> list(String type, String q, int limit, int offset) {
    String sql =
        """
        SELECT CAST(id AS CHAR) AS id, slug, name, type, author, latest_version, description,
               homepage_url, changelog_url, deprecated, updated_at
          FROM mcp_packages
         WHERE (:type IS NULL OR type = :type)
           AND (:q IS NULL OR (name LIKE :pattern OR description LIKE :pattern))
         ORDER BY name ASC
         LIMIT :limit OFFSET :offset
        """;
    var params = new MapSqlParameterSource()
        .addValue("type", type)
        .addValue("q", q)
        .addValue("pattern", q == null ? null : "%" + q + "%")
        .addValue("limit", limit)
        .addValue("offset", offset);
    return jdbc.query(sql, params, (rs, i) -> map(rs));
  }

  public Optional<McpPackage> findBySlug(String slug) {
    String sql =
        "SELECT CAST(id AS CHAR) AS id, slug, name, type, author, latest_version, description, "
            + "homepage_url, changelog_url, deprecated, updated_at "
            + "FROM mcp_packages WHERE slug = :slug";
    var params = new MapSqlParameterSource("slug", slug);
    return jdbc.query(sql, params, (rs, i) -> map(rs)).stream().findFirst();
  }

  public Optional<McpVersion> findVersion(String slug, String version) {
    String sql =
        """
        SELECT v.version, v.manifest_json, v.download_url, v.sha256, v.signature, v.signed_at
          FROM mcp_versions v
          JOIN mcp_packages p ON p.id = v.package_id
         WHERE p.slug = :slug AND v.version = :version
        """;
    var params = new MapSqlParameterSource().addValue("slug", slug).addValue("version", version);
    return jdbc.query(
            sql,
            params,
            (rs, i) -> {
              JsonNode manifest = readJson(rs.getString("manifest_json"));
              return new McpVersion(
                  slug,
                  rs.getString("version"),
                  manifest,
                  rs.getString("download_url"),
                  rs.getString("sha256"),
                  rs.getString("signature"),
                  rs.getTimestamp("signed_at").toInstant());
            })
        .stream()
        .findFirst();
  }

  /** Strips system-package manifests down to the safe summary set. */
  public JsonNode redactManifestForSystem(JsonNode manifest) {
    if (manifest == null || manifest.isNull()) return manifest;
    ObjectNode out = mapper.createObjectNode();
    SYSTEM_MANIFEST_SAFE_KEYS.forEach(
        k -> {
          if (manifest.has(k)) out.set(k, manifest.get(k));
        });
    return out;
  }

  private JsonNode readJson(String raw) {
    try {
      return raw == null ? null : mapper.readTree(raw);
    } catch (Exception e) {
      return null;
    }
  }

  private McpPackage map(java.sql.ResultSet rs) throws java.sql.SQLException {
    Timestamp ts = rs.getTimestamp("updated_at");
    return new McpPackage(
        rs.getString("id"),
        rs.getString("slug"),
        rs.getString("name"),
        rs.getString("type"),
        rs.getString("author"),
        rs.getString("latest_version"),
        rs.getString("description"),
        rs.getString("homepage_url"),
        rs.getString("changelog_url"),
        rs.getBoolean("deprecated"),
        ts == null ? null : ts.toInstant());
  }
}