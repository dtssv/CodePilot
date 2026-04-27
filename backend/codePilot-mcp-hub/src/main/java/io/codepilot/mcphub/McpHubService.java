package io.codepilot.mcphub;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Service for the MCP/Skill marketplace hub.
 *
 * <p>Handles: package search, detail, version listing, manifest, download URL generation,
 * install/uninstall/update metadata recording.
 *
 * <p>Actual file downloads are served from object storage (MinIO/S3) via signed URLs.
 * The backend never stores or serves the actual package content.
 */
@Service
public class McpHubService {

  private static final Logger LOG = LoggerFactory.getLogger(McpHubService.class);
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

  private static final RowMapper<McpPackage> PACKAGE_MAPPER = (rs, rowNum) ->
      new McpPackage(
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
          rs.getTimestamp("created_at").toInstant(),
          rs.getTimestamp("updated_at").toInstant());

  private static final RowMapper<McpVersion> VERSION_MAPPER = (rs, rowNum) ->
      new McpVersion(
          rs.getString("id"),
          rs.getString("package_id"),
          rs.getString("version"),
          parseJsonMap(rs.getString("manifest_json")),
          rs.getString("download_url"),
          rs.getString("sha256"),
          rs.getString("signature"),
          rs.getTimestamp("signed_at").toInstant());

  private final JdbcTemplate jdbc;

  public McpHubService(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  /** Search packages by type, query string, with pagination. */
  public Mono<List<McpPackage>> searchPackages(String type, String query, int page, int size) {
    return Mono.fromCallable(() -> {
      StringBuilder sql = new StringBuilder(
          "SELECT * FROM mcp_packages WHERE deprecated = false");
      List<Object> params = new java.util.ArrayList<>();

      if (type != null && !type.isBlank()) {
        sql.append(" AND type = ?");
        params.add(type);
      }
      if (query != null && !query.isBlank()) {
        sql.append(" AND (name ILIKE ? OR description ILIKE ?)");
        params.add("%" + query + "%");
        params.add("%" + query + "%");
      }

      sql.append(" ORDER BY name LIMIT ? OFFSET ?");
      params.add(size);
      params.add(page * size);

      return jdbc.query(sql.toString(), PACKAGE_MAPPER, params.toArray());
    }).subscribeOn(Schedulers.boundedElastic());
  }

  /** Get package details by slug. */
  public Mono<McpPackage> getPackageBySlug(String slug) {
    return Mono.fromCallable(
            () -> jdbc.queryForObject(
                "SELECT * FROM mcp_packages WHERE slug = ?",
                PACKAGE_MAPPER, slug))
        .subscribeOn(Schedulers.boundedElastic());
  }

  /** Get all versions for a package. */
  public Mono<List<McpVersion>> getVersions(String slug) {
    return Mono.fromCallable(
            () -> jdbc.query(
                "SELECT v.* FROM mcp_versions v"
                    + " JOIN mcp_packages p ON v.package_id = p.id"
                    + " WHERE p.slug = ?"
                    + " ORDER BY v.signed_at DESC",
                VERSION_MAPPER, slug))
        .subscribeOn(Schedulers.boundedElastic());
  }

  /** Get a specific version's manifest. */
  public Mono<McpVersion> getVersion(String slug, String version) {
    return Mono.fromCallable(
            () -> jdbc.queryForObject(
                "SELECT v.* FROM mcp_versions v"
                    + " JOIN mcp_packages p ON v.package_id = p.id"
                    + " WHERE p.slug = ? AND v.version = ?",
                VERSION_MAPPER, slug, version))
        .subscribeOn(Schedulers.boundedElastic());
  }

  /** Record an install. */
  public Mono<Void> install(String userId, InstallRequest req) {
    return Mono.<Void>fromCallable(() -> {
      jdbc.update(
          "INSERT INTO install_records"
              + " (user_id, package_slug, version, scope, source)"
              + " VALUES (?::uuid, ?, ?, ?, 'official')"
              + " ON CONFLICT (user_id, package_slug, version, scope, source)"
              + " DO UPDATE SET uninstalled_at = NULL, installed_at = now()",
          userId, req.slug(), req.version(), req.scope());
      return null;
    }).subscribeOn(Schedulers.boundedElastic());
  }

  /** Record an uninstall (soft-delete by setting uninstalled_at). */
  public Mono<Void> uninstall(String userId, InstallRequest req) {
    return Mono.<Void>fromCallable(() -> {
      jdbc.update(
          "UPDATE install_records SET uninstalled_at = now()"
              + " WHERE user_id = ?::uuid AND package_slug = ? AND version = ? AND scope = ?"
              + " AND uninstalled_at IS NULL",
          userId, req.slug(), req.version(), req.scope());
      return null;
    }).subscribeOn(Schedulers.boundedElastic());
  }

  /** Record an update (uninstall old + install new). */
  public Mono<Void> update(String userId, InstallRequest req) {
    return uninstall(userId, req).then(install(userId, req));
  }

  // ---- JSON helpers ----

  private static Map<String, Object> parseJsonMap(String json) {
    if (json == null || json.isBlank()) return Map.of();
    try { return MAPPER.readValue(json, MAP_TYPE); }
    catch (Exception e) { return Map.of(); }
  }
}