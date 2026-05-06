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
        VALUES (cast(:user_id as uuid), :slug, :version, :scope, :source)
        ON CONFLICT (user_id, package_slug, version, scope, source)
            DO UPDATE SET uninstalled_at = NULL
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
         WHERE user_id = cast(:user_id as uuid)
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