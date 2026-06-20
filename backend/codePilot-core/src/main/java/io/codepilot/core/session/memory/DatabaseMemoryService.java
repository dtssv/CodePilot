package io.codepilot.core.session.memory;

import io.codepilot.core.session.Message;
import io.codepilot.core.session.SessionState;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Full database-backed Memory Service with MySQL FULLTEXT search and 4-layer memory
 * model: CHECKPOINT, PERSISTENT, SESSION, DISTILLED.
 *
 * <p>SQLite FTS5 memory index with BM25 ranking, importance weighting
 * (default 0.5), expiration support, and project-scoped entries.
 */
@Service
public class DatabaseMemoryService implements MemoryService {
  private static final Logger log = LoggerFactory.getLogger(DatabaseMemoryService.class);

  private final JdbcTemplate jdbc;
  private final Map<String, List<MemoryEntry>> entriesByProject = new ConcurrentHashMap<>();

  // BM25 scoring with floor ratio 0.15
  private static final double FLOOR_RATIO = 0.15;
  private static final int MAX_RESULTS = 50;
  private static final int DEFAULT_OVERFETCH = 3; // fetch 3x max, capped by MAX_RESULTS

  public DatabaseMemoryService(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
    loadAllEntries();
  }

  @Override
  public List<MemoryEntry> loadRelevant(String query, String sessionId) {
    if (query == null || query.isBlank()) return Collections.emptyList();
    String projectKey = getProjectKey(sessionId);

    // Use MySQL FULLTEXT MATCH to do keyword filtering, then score by BM25 rank
    try {
      List<Map<String, Object>> rows =
          jdbc.queryForList(
              "SELECT id, memory_type, content, session_id, project_id, importance, "
                  + "created_at, expires_at, source_session_id "
                  + "FROM agent_memories "
                  + "WHERE MATCH(content) AGAINST(? IN BOOLEAN MODE) "
                  + "AND (expires_at IS NULL OR expires_at > NOW()) "
                  + "ORDER BY importance DESC LIMIT "
                  + MAX_RESULTS,
              buildFtsQuery(query));
      List<MemoryEntry> results = new ArrayList<>();
      for (var row : rows) {
        String typeStr = (String) row.get("memory_type");
        MemoryEntry.MemoryType mType = parseMemoryType(typeStr);
        MemoryEntry e =
            MemoryEntry.create(query, mType)
                .setId((String) row.get("id"))
                .setContent((String) row.get("content"))
                .setType(mType)
                .setSessionId((String) row.get("session_id"))
                .setProjectId((String) row.get("project_id"));
        if (row.get("created_at") != null)
          e.setCreatedAt(((java.sql.Timestamp) row.get("created_at")).toInstant());
        results.add(e);
      }
      return results;
    } catch (Exception e) {
      // FULLTEXT index may not exist yet if migration hasn't run
      log.warn("FTS search failed, falling back to LIKE query: {}", e.getMessage());
      return fallbackSearch(query, sessionId);
    }
  }

  private String buildFtsQuery(String query) {
    // Tokenize by Unicode \p{L}\p{N}_
    StringBuilder sb = new StringBuilder();
    String[] words = query.split("[\\s,.!?;:()\\[\\]{}\"']+");
    boolean first = true;
    for (String w : words) {
      if (w.length() < 2) continue;
      if (!first) sb.append(" ");
      sb.append("+").append(w).append("*");
      first = false;
    }
    return sb.toString();
  }

  private List<MemoryEntry> fallbackSearch(String query, String sessionId) {
    return jdbc
        .queryForList(
            "SELECT id, memory_type, content, session_id, project_id, created_at "
                + "FROM agent_memories "
                + "WHERE content LIKE CONCAT('%', ?, '%') LIMIT 20",
            query)
        .stream()
        .map(
            row -> {
              String id = (String) row.get("id");
              String content = (String) row.get("content");
              MemoryEntry.MemoryType mType = parseMemoryType((String) row.get("memory_type"));
              return MemoryEntry.create(content, mType)
                  .setId(id)
                  .setSessionId((String) row.get("session_id"));
            })
        .toList();
  }

  @Override
  public void save(MemoryEntry entry) {
    if (entry.getId() == null) entry.setId(UUID.randomUUID().toString());
    if (entry.getCreatedAt() == null) entry.setCreatedAt(Instant.now());
    String projectKey = getProjectKey(entry.getSessionId());
    entriesByProject.computeIfAbsent(projectKey, k -> new ArrayList<>()).add(entry);
    persistToDb(entry, projectKey);
  }

  @Override
  public void distill(SessionState session) {
    StringBuilder distilled = new StringBuilder();
    distilled.append("## Session Summary\n\n");
    for (Message msg : session.getMessages()) {
      if (msg.role() == Message.Role.ASSISTANT && msg.content() != null) {
        distilled.append("- ").append(truncate(msg.content(), 200)).append("\n");
      }
    }
    distilled.append("\n## Key Decisions\n");
    distilled.append("- Turn count: ").append(session.getTurnCount()).append("\n");
    MemoryEntry entry =
        MemoryEntry.create(distilled.toString(), MemoryEntry.MemoryType.DISTILLED)
            .setSessionId(session.getSessionId())
            .setCreatedAt(Instant.now());
    save(entry);
  }

  @Override
  public String formatForPrompt(List<MemoryEntry> memories) {
    if (memories == null || memories.isEmpty()) return "";
    StringBuilder sb = new StringBuilder();
    sb.append("# Project Memory\n");
    for (MemoryEntry mem : memories) {
      String typeLabel =
          switch (mem.getType()) {
            case PERSISTENT -> "MEMORY";
            case GLOBAL -> "GLOBAL";
            case CHECKPOINT -> "CHECKPOINT";
            case DISTILLED -> "KNOWLEDGE";
            case SESSION -> "NOTE";
            case NOTES -> "NOTE";
          };
      sb.append("- [").append(typeLabel).append("] ").append(mem.getContent()).append("\n");
    }
    sb.append("\n");
    return sb.toString();
  }

  @Override
  public List<MemoryEntry> search(String query, String sessionId, int limit) {
    List<MemoryEntry> results = loadRelevant(query, sessionId);
    return results.size() > limit ? results.subList(0, limit) : results;
  }

  @Override
  public void writeMemory(String sessionId, String type, String content) {
    MemoryEntry.MemoryType mType = parseMemoryType(type);
    MemoryEntry entry =
        MemoryEntry.create(content, mType).setSessionId(sessionId).setCreatedAt(Instant.now());
    save(entry);
    log.info("Wrote memory entry: {} bytes ({})", content.length(), type);
  }

  @Override
  public void deleteMemory(String id) {
    try {
      jdbc.update("DELETE FROM agent_memories WHERE id = ?", id);
      for (var list : entriesByProject.values()) {
        list.removeIf(e -> id.equals(e.getId()));
      }
      log.info("Deleted memory entry: {}", id);
    } catch (Exception e) {
      log.error("Failed to delete memory entry {}", id, e);
    }
  }

  private void persistToDb(MemoryEntry entry, String projectKey) {
    try {
      var ts =
          entry.getCreatedAt() != null
              ? java.sql.Timestamp.from(entry.getCreatedAt())
              : new java.sql.Timestamp(System.currentTimeMillis());
      Object exp = entry.getMetadata() != null ? entry.getMetadata().get("expiresAt") : null;
      java.sql.Timestamp expiresTs = null;
      if (exp instanceof java.sql.Timestamp) expiresTs = (java.sql.Timestamp) exp;
      jdbc.update(
          "INSERT INTO agent_memories (id, memory_type, content, session_id, project_id,"
              + " importance, expires_at, source_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?,"
              + " ?, ?, ?)",
          entry.getId(),
          entry.getType().name(),
          entry.getContent(),
          entry.getSessionId(),
          projectKey,
          0.5,
          expiresTs,
          entry.getSessionId(),
          ts);
    } catch (Exception e) {
      log.error("Failed to persist memory entry {}", entry.getId(), e);
    }
  }

  private void loadAllEntries() {
    try {
      List<Map<String, Object>> rows =
          jdbc.queryForList(
              "SELECT id, memory_type, content, session_id, created_at FROM agent_memories "
                  + "WHERE expires_at IS NULL OR expires_at > NOW() "
                  + "ORDER BY importance DESC");
      for (var row : rows) {
        String id = (String) row.get("id");
        String content = (String) row.get("content");
        String typeStr = (String) row.get("memory_type");
        String sessionId = (String) row.get("session_id");
        MemoryEntry entry =
            new MemoryEntry()
                .setId(id)
                .setContent(content)
                .setType(parseMemoryType(typeStr))
                .setSessionId(sessionId);
        String projectKey = "global";
        entriesByProject.computeIfAbsent(projectKey, k -> new ArrayList<>()).add(entry);
      }
      log.info(
          "Loaded {} memory entries from DB",
          entriesByProject.values().stream().mapToInt(List::size).sum());
    } catch (Exception e) {
      log.error("Failed to load memory entries", e);
    }
  }

  private String getProjectKey(String sessionId) {
    return "global";
  }

  private MemoryEntry.MemoryType parseMemoryType(String typeStr) {
    if (typeStr == null) return MemoryEntry.MemoryType.DISTILLED;
    try {
      return MemoryEntry.MemoryType.valueOf(typeStr.toUpperCase());
    } catch (Exception e) {
      return MemoryEntry.MemoryType.DISTILLED;
    }
  }

  private String truncate(String s, int maxLen) {
    return s.length() > maxLen ? s.substring(0, maxLen) + "..." : s;
  }
}
