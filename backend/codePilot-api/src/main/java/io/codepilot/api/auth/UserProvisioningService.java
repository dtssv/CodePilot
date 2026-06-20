package io.codepilot.api.auth;

import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Ensures {@code tenants} / {@code users} rows exist after SSO login so FK-backed features (custom
 * models, install records, devices, …) work without manual seeding.
 */
@Service
public class UserProvisioningService {

  private static final Logger log = LoggerFactory.getLogger(UserProvisioningService.class);

  private final NamedParameterJdbcTemplate jdbc;

  public UserProvisioningService(NamedParameterJdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public record ProvisionedIdentity(String userId, String tenantId) {}

  @Transactional
  public ProvisionedIdentity ensureProvisioned(SsoVerifier.VerifiedIdentity identity) {
    String tenantDbId = ensureTenant(identity.tenantId());
    String userDbId = ensureUser(tenantDbId, identity);
    log.info(
        "Provisioned login: ssoSubject={} tenantKey={} -> userId={} tenantId={}",
        identity.subject(),
        identity.tenantId(),
        userDbId,
        tenantDbId);
    return new ProvisionedIdentity(userDbId, tenantDbId);
  }

  private String ensureTenant(String tenantKey) {
    String key = tenantKey != null ? tenantKey.trim() : "";
    if (key.isEmpty()) {
      key = "default";
    }

    if (isUuid(key)) {
      List<String> byId =
          jdbc.query(
              "SELECT id FROM tenants WHERE id = :id LIMIT 1",
              new MapSqlParameterSource("id", key),
              (rs, rowNum) -> rs.getString("id"));
      if (!byId.isEmpty()) {
        return byId.getFirst();
      }
    }

    List<String> bySlug =
        jdbc.query(
            "SELECT id FROM tenants WHERE slug = :slug LIMIT 1",
            new MapSqlParameterSource("slug", key),
            (rs, rowNum) -> rs.getString("id"));
    if (!bySlug.isEmpty()) {
      return bySlug.getFirst();
    }

    String id = isUuid(key) ? key : UUID.randomUUID().toString();
    try {
      jdbc.update(
          "INSERT INTO tenants (id, slug, name) VALUES (:id, :slug, :name)",
          new MapSqlParameterSource()
              .addValue("id", id)
              .addValue("slug", key)
              .addValue("name", key));
    } catch (DuplicateKeyException dup) {
      bySlug =
          jdbc.query(
              "SELECT id FROM tenants WHERE slug = :slug LIMIT 1",
              new MapSqlParameterSource("slug", key),
              (rs, rowNum) -> rs.getString("id"));
      if (!bySlug.isEmpty()) {
        return bySlug.getFirst();
      }
      throw dup;
    }
    return id;
  }

  private String ensureUser(String tenantDbId, SsoVerifier.VerifiedIdentity identity) {
    String subject = identity.subject() != null ? identity.subject().trim() : "";
    if (subject.isEmpty()) {
      subject = "anonymous";
    }
    String displayName =
        identity.displayName() != null && !identity.displayName().isBlank()
            ? identity.displayName().trim()
            : subject;
    String email =
        identity.email() != null && !identity.email().isBlank()
            ? identity.email().trim()
            : subject + "@local";

    List<String> existing =
        jdbc.query(
            """
            SELECT id FROM users
            WHERE tenant_id = :tenantId AND sso_subject = :ssoSubject
            LIMIT 1
            """,
            new MapSqlParameterSource()
                .addValue("tenantId", tenantDbId)
                .addValue("ssoSubject", subject),
            (rs, rowNum) -> rs.getString("id"));
    if (!existing.isEmpty()) {
      String userId = existing.getFirst();
      jdbc.update(
          """
          UPDATE users SET display_name = :displayName, email = :email
          WHERE id = :id
          """,
          new MapSqlParameterSource()
              .addValue("id", userId)
              .addValue("displayName", displayName)
              .addValue("email", email));
      return userId;
    }

    String userId = UUID.randomUUID().toString();
    try {
      jdbc.update(
          """
          INSERT INTO users (id, tenant_id, sso_subject, display_name, email)
          VALUES (:id, :tenantId, :ssoSubject, :displayName, :email)
          """,
          new MapSqlParameterSource()
              .addValue("id", userId)
              .addValue("tenantId", tenantDbId)
              .addValue("ssoSubject", subject)
              .addValue("displayName", displayName)
              .addValue("email", email));
    } catch (DuplicateKeyException dup) {
      existing =
          jdbc.query(
              """
              SELECT id FROM users
              WHERE tenant_id = :tenantId AND sso_subject = :ssoSubject
              LIMIT 1
              """,
              new MapSqlParameterSource()
                  .addValue("tenantId", tenantDbId)
                  .addValue("ssoSubject", subject),
              (rs, rowNum) -> rs.getString("id"));
      if (!existing.isEmpty()) {
        return existing.getFirst();
      }
      throw dup;
    }
    return userId;
  }

  private static boolean isUuid(String value) {
    try {
      UUID.fromString(value);
      return true;
    } catch (IllegalArgumentException e) {
      return false;
    }
  }
}
