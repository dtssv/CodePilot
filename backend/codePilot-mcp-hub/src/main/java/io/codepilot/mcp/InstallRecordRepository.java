package io.codepilot.mcp;

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/** Insert / update / delete metadata on user installs (no Skill body is ever persisted). */
@Repository
public class InstallRecordRepository {

  private final NamedParameterJdbcTemplate jdbc;

  public InstallRecordRepository(NamedParameterJdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public int recordInstall(
      String userId, String packageSlug, String version, String scope, String source) {
    String sql =
        """
        INSERT INTO install_records(user_id, package_slug, version, scope, source)
        VALUES (:user_id, :slug, :version, :scope, :source)
        ON DUPLICATE KEY UPDATE uninstalled_at = NULL
        """;
    return jdbc.update(sql, new MapSqlParameterSource()
        .addValue("user_id", userId)
        .addValue("slug", packageSlug)
        .addValue("version", version)
        .addValue("scope", scope)
        .addValue("source", source));
  }

  public int recordUninstall(
      String userId, String packageSlug, String version, String scope, String source) {
    String sql =
        """
        UPDATE install_records
           SET uninstalled_at = NOW()
         WHERE user_id = :user_id
           AND package_slug = :slug
           AND version = :version
           AND scope = :scope
           AND source = :source
        """;
    return jdbc.update(sql, new MapSqlParameterSource()
        .addValue("user_id", userId)
        .addValue("slug", packageSlug)
        .addValue("version", version)
        .addValue("scope", scope)
        .addValue("source", source));
  }
}