package io.codepilot.api.share;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Conversation share snapshots.
 *
 * <p>Primary: {@code conversation_shares} (Flyway V9). Fallback: per-id JSON files under
 * storage-dir.
 */
@Component
public class SharePersistenceStore {

  private static final Logger log = LoggerFactory.getLogger(SharePersistenceStore.class);

  private final ObjectMapper mapper = new ObjectMapper();
  private final NamedParameterJdbcTemplate jdbc;
  private final Path storageDir;
  private final String persistenceMode;
  private volatile boolean dbActive;

  public record ShareSnapshot(
      String id,
      String title,
      String format,
      String content,
      Instant createdAt,
      Instant expiresAt,
      boolean revoked) {}

  public SharePersistenceStore(
      NamedParameterJdbcTemplate jdbc,
      @Value("${codepilot.share.persistence:auto}") String persistenceMode,
      @Value("${codepilot.share.storage-dir:${java.io.tmpdir}/codepilot-share}")
          String storageDir) {
    this.jdbc = jdbc;
    this.persistenceMode = persistenceMode != null ? persistenceMode.trim().toLowerCase() : "auto";
    this.storageDir = Path.of(storageDir);
  }

  @PostConstruct
  void init() {
    if ("file".equals(persistenceMode)) {
      dbActive = false;
      log.info("Share persistence: file ({})", storageDir);
      return;
    }
    if (probeDb()) {
      dbActive = true;
      importFilesIfDbEmpty();
      log.info("Share persistence: database");
    } else {
      dbActive = false;
      log.warn("Share persistence: file fallback ({})", storageDir);
    }
  }

  public boolean isDbBacked() {
    return dbActive;
  }

  public ShareSnapshot create(String title, String format, String content, int expireDays)
      throws Exception {
    String id = java.util.UUID.randomUUID().toString();
    Instant createdAt = Instant.now();
    Instant expiresAt = createdAt.plus(expireDays, ChronoUnit.DAYS);
    String safeTitle = title != null && !title.isBlank() ? title : "CodePilot Share";
    String safeFormat = format != null && !format.isBlank() ? format : "markdown";
    if (dbActive) {
      jdbc.update(
          """
          INSERT INTO conversation_shares (id, title, format, content, created_at, expires_at)
          VALUES (:id, :title, :format, :content, :createdAt, :expiresAt)
          """,
          new MapSqlParameterSource()
              .addValue("id", id)
              .addValue("title", safeTitle)
              .addValue("format", safeFormat)
              .addValue("content", content)
              .addValue("createdAt", java.sql.Timestamp.from(createdAt))
              .addValue("expiresAt", java.sql.Timestamp.from(expiresAt)));
      return new ShareSnapshot(id, safeTitle, safeFormat, content, createdAt, expiresAt, false);
    }
    Files.createDirectories(storageDir);
    String body =
        """
        {
          "id": "%s",
          "title": %s,
          "format": "%s",
          "createdAt": "%s",
          "expiresAt": "%s",
          "content": %s
        }
        """
            .formatted(id, json(safeTitle), safeFormat, createdAt, expiresAt, json(content));
    Files.writeString(storageDir.resolve(id + ".json"), body);
    return new ShareSnapshot(id, safeTitle, safeFormat, content, createdAt, expiresAt, false);
  }

  public Optional<ShareSnapshot> get(String id) throws Exception {
    if (dbActive) {
      return loadFromDb(id);
    }
    return loadFromFile(id);
  }

  public boolean revoke(String id) throws Exception {
    if (dbActive) {
      int n =
          jdbc.update(
              "UPDATE conversation_shares SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = :id AND"
                  + " revoked_at IS NULL",
              Map.of("id", id));
      return n > 0;
    }
    Path path = storageDir.resolve(id + ".json").normalize();
    return path.startsWith(storageDir) && Files.deleteIfExists(path);
  }

  private boolean probeDb() {
    if ("file".equals(persistenceMode)) return false;
    try {
      jdbc.queryForObject("SELECT COUNT(*) FROM conversation_shares", Map.of(), Integer.class);
      return true;
    } catch (DataAccessException e) {
      return false;
    }
  }

  private void importFilesIfDbEmpty() {
    try {
      Integer count =
          jdbc.queryForObject("SELECT COUNT(*) FROM conversation_shares", Map.of(), Integer.class);
      if (count != null && count > 0) return;
      if (!Files.isDirectory(storageDir)) return;
      int imported = 0;
      try (Stream<Path> stream = Files.list(storageDir)) {
        for (Path p : stream.filter(f -> f.toString().endsWith(".json")).toList()) {
          String id = p.getFileName().toString().replace(".json", "");
          Optional<ShareSnapshot> snap = loadFromFile(id);
          if (snap.isEmpty()) continue;
          ShareSnapshot s = snap.get();
          jdbc.update(
              """
INSERT INTO conversation_shares (id, title, format, content, created_at, expires_at, revoked_at)
VALUES (:id, :title, :format, :content, :createdAt, :expiresAt, NULL)
""",
              new MapSqlParameterSource()
                  .addValue("id", s.id())
                  .addValue("title", s.title())
                  .addValue("format", s.format())
                  .addValue("content", s.content())
                  .addValue("createdAt", java.sql.Timestamp.from(s.createdAt()))
                  .addValue("expiresAt", java.sql.Timestamp.from(s.expiresAt())));
          imported++;
        }
      }
      if (imported > 0) log.info("Imported {} share snapshots from files into database", imported);
    } catch (Exception e) {
      log.warn("Share file import skipped: {}", e.getMessage());
    }
  }

  private Optional<ShareSnapshot> loadFromDb(String id) {
    return jdbc
        .query(
            """
            SELECT id, title, format, content, created_at, expires_at, revoked_at
            FROM conversation_shares WHERE id = :id
            """,
            Map.of("id", id),
            (rs, rowNum) ->
                new ShareSnapshot(
                    rs.getString("id"),
                    rs.getString("title"),
                    rs.getString("format"),
                    rs.getString("content"),
                    rs.getTimestamp("created_at").toInstant(),
                    rs.getTimestamp("expires_at").toInstant(),
                    rs.getTimestamp("revoked_at") != null))
        .stream()
        .findFirst();
  }

  private Optional<ShareSnapshot> loadFromFile(String id) throws Exception {
    Path path = storageDir.resolve(id + ".json").normalize();
    if (!path.startsWith(storageDir) || !Files.exists(path)) {
      return Optional.empty();
    }
    JsonNode node = mapper.readTree(Files.readString(path));
    Instant createdAt = Instant.parse(node.path("createdAt").asText(Instant.now().toString()));
    Instant expiresAt =
        Instant.parse(node.path("expiresAt").asText(createdAt.plus(7, ChronoUnit.DAYS).toString()));
    return Optional.of(
        new ShareSnapshot(
            node.path("id").asText(id),
            node.path("title").asText("CodePilot Share"),
            node.path("format").asText("markdown"),
            node.path("content").asText(""),
            createdAt,
            expiresAt,
            false));
  }

  private static String json(String s) {
    return "\""
        + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")
        + "\"";
  }
}
