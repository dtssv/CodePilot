package io.codepilot.core.rag;

import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Data access layer for the {@code rag_chunks} table (pgvector). All operations are batched where
 * appropriate to minimise round-trips.
 */
@Repository
public class RagRepository {

  private final NamedParameterJdbcTemplate jdbc;

  public RagRepository(NamedParameterJdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  // ------- Batch insert (up to 1000 per invocation) ------- //

  public void batchInsert(List<RagChunk> chunks) {
    if (chunks == null || chunks.isEmpty()) return;
    String sql =
        """
        INSERT INTO rag_chunks(session_id, user_id, path, lang, start_line, end_line,
                               content_hash, snippet, embedding, expires_at)
        VALUES (cast(:sessionId as uuid), cast(:userId as uuid), :path, :lang, :startLine,
                :endLine, :contentHash, :snippet, cast(:embedding as vector), NOW() + INTERVAL '24 hours')
        """;
    MapSqlParameterSource[] batchParams =
        chunks.stream()
            .map(
                c ->
                    new MapSqlParameterSource()
                        .addValue("sessionId", c.sessionId().toString())
                        .addValue("userId", c.userId().toString())
                        .addValue("path", c.path())
                        .addValue("lang", c.lang())
                        .addValue("startLine", c.startLine())
                        .addValue("endLine", c.endLine())
                        .addValue("contentHash", c.contentHash())
                        .addValue("snippet", truncate(c.snippet(), 4096))
                        .addValue("embedding", toVectorLiteral(c.embedding())))
            .toArray(MapSqlParameterSource[]::new);
    jdbc.batchUpdate(sql, batchParams);
  }

  // ------- Search by cosine similarity ------- //

  public List<RagSearchHit> search(UUID sessionId, float[] queryEmbedding, int topK) {
    String sql =
        """
        SELECT path, lang, start_line, end_line, snippet,
               1 - (embedding <=> cast(:embedding as vector)) AS score
        FROM rag_chunks
        WHERE session_id = cast(:sessionId as uuid)
          AND expires_at > NOW()
        ORDER BY embedding <=> cast(:embedding as vector)
        LIMIT :topK
        """;
    var params =
        new MapSqlParameterSource()
            .addValue("sessionId", sessionId.toString())
            .addValue("embedding", toVectorLiteral(queryEmbedding))
            .addValue("topK", topK);
    return jdbc.query(sql, params, (rs, rowNum) -> mapSearchHit(rs));
  }

  // ------- Delete by session ------- //

  public int deleteBySession(UUID sessionId) {
    String sql = "DELETE FROM rag_chunks WHERE session_id = cast(:sessionId as uuid)";
    return jdbc.update(sql, new MapSqlParameterSource("sessionId", sessionId.toString()));
  }

  // ------- Cleanup expired ------- //

  public int deleteExpired() {
    String sql = "DELETE FROM rag_chunks WHERE expires_at < NOW()";
    return jdbc.update(sql, new MapSqlParameterSource());
  }

  // ------- Count by session ------- //

  public int countBySession(UUID sessionId) {
    String sql =
        "SELECT COUNT(*) FROM rag_chunks WHERE session_id = cast(:sessionId as uuid) AND expires_at > NOW()";
    Integer count =
        jdbc.queryForObject(
            sql, new MapSqlParameterSource("sessionId", sessionId.toString()), Integer.class);
    return count == null ? 0 : count;
  }

  // ------- Private helpers ------- //

  private static RagSearchHit mapSearchHit(ResultSet rs) throws SQLException {
    return new RagSearchHit(
        rs.getString("path"),
        rs.getString("lang"),
        rs.getObject("start_line") == null ? null : rs.getInt("start_line"),
        rs.getObject("end_line") == null ? null : rs.getInt("end_line"),
        rs.getString("snippet"),
        rs.getDouble("score"));
  }

  private static String toVectorLiteral(float[] embedding) {
    if (embedding == null || embedding.length == 0) return "[0]";
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < embedding.length; i++) {
      if (i > 0) sb.append(',');
      sb.append(embedding[i]);
    }
    sb.append(']');
    return sb.toString();
  }

  private static String truncate(String s, int maxLen) {
    if (s == null) return "";
    return s.length() <= maxLen ? s : s.substring(0, maxLen);
  }
}