package io.codepilot.core.rag;

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
        VALUES (:sessionId, :userId, :path, :lang, :startLine,
                :endLine, :contentHash, :snippet, :embedding, DATE_ADD(NOW(3), INTERVAL 24 HOUR))
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
                        .addValue("embedding", toBytes(c.embedding())))
            .toArray(MapSqlParameterSource[]::new);
    jdbc.batchUpdate(sql, batchParams);
  }

  // ------- Search by cosine similarity (app-layer computation for MySQL) ------- //

  public List<RagSearchHit> search(UUID sessionId, float[] queryEmbedding, int topK) {
    // MySQL has no native vector ops; fetch all embeddings for the session and compute in Java
    String sql =
        """
        SELECT path, lang, start_line, end_line, snippet, embedding
        FROM rag_chunks
        WHERE session_id = :sessionId
          AND expires_at > NOW(3)
        """;
    var params = new MapSqlParameterSource().addValue("sessionId", sessionId.toString());
    List<RagSearchHit> candidates = jdbc.query(sql, params, (rs, rowNum) -> {
      float[] emb = fromBytes(rs.getBytes("embedding"));
      double score = cosineSimilarity(queryEmbedding, emb);
      return new RagSearchHit(
          rs.getString("path"),
          rs.getString("lang"),
          rs.getObject("start_line") == null ? null : rs.getInt("start_line"),
          rs.getObject("end_line") == null ? null : rs.getInt("end_line"),
          rs.getString("snippet"),
          score);
    });
    // Sort by score descending and return top-K
    candidates.sort((a, b) -> Double.compare(b.score(), a.score()));
    return candidates.stream().limit(topK).toList();
  }

  // ------- Delete by session ------- //

  public int deleteBySession(UUID sessionId) {
    String sql = "DELETE FROM rag_chunks WHERE session_id = :sessionId";
    return jdbc.update(sql, new MapSqlParameterSource("sessionId", sessionId.toString()));
  }

  // ------- Cleanup expired ------- //

  public int deleteExpired() {
    String sql = "DELETE FROM rag_chunks WHERE expires_at < NOW(3)";
    return jdbc.update(sql, new MapSqlParameterSource());
  }

  // ------- Count by session ------- //

  public int countBySession(UUID sessionId) {
    String sql =
        "SELECT COUNT(*) FROM rag_chunks WHERE session_id = :sessionId AND expires_at > NOW(3)";
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

  /** Convert float[] to byte[] (IEEE 754, big-endian) for BLOB storage. */
  private static byte[] toBytes(float[] embedding) {
    if (embedding == null) return new byte[0];
    java.nio.ByteBuffer buf = java.nio.ByteBuffer.allocate(embedding.length * 4);
    for (float f : embedding) buf.putFloat(f);
    return buf.array();
  }

  /** Convert byte[] back to float[] from BLOB storage. */
  private static float[] fromBytes(byte[] data) {
    if (data == null || data.length == 0) return new float[0];
    java.nio.ByteBuffer buf = java.nio.ByteBuffer.wrap(data);
    float[] result = new float[data.length / 4];
    for (int i = 0; i < result.length; i++) result[i] = buf.getFloat();
    return result;
  }

  /** Cosine similarity between two vectors. */
  private static double cosineSimilarity(float[] a, float[] b) {
    if (a.length != b.length || a.length == 0) return 0.0;
    double dot = 0, normA = 0, normB = 0;
    for (int i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    double denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom == 0 ? 0.0 : dot / denom;
  }

  private static String truncate(String s, int maxLen) {
    if (s == null) return "";
    return s.length() <= maxLen ? s : s.substring(0, maxLen);
  }
}