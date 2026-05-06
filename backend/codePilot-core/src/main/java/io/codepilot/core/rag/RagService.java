package io.codepilot.core.rag;

import com.google.common.collect.Lists;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.rag.dto.RagIndexRequest;
import io.codepilot.core.rag.dto.RagSearchRequest;
import io.codepilot.core.rag.dto.RagSearchResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.embedding.EmbeddingResponse;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Core RAG service: accepts chunked uploads, computes embeddings via Spring AI EmbeddingModel, and
 * persists them into pgvector. Search returns top-k cosine-similarity results scoped to a session.
 *
 * <p>All chunks carry a 24-hour TTL and are never shared across sessions or users.
 */
@Service
public class RagService {

  private static final Logger log = LoggerFactory.getLogger(RagService.class);

  /** Maximum chunks per single index request to prevent abuse. */
  private static final int MAX_CHUNKS_PER_REQUEST = 200;

  /** Maximum raw content size per chunk (32 KB). */
  private static final int MAX_CHUNK_CONTENT_BYTES = 32 * 1024;

  /** Batch size for embedding API calls. */
  private static final int EMBEDDING_BATCH_SIZE = 64;

  private final EmbeddingModel embeddingModel;
  private final RagRepository repository;

  public RagService(EmbeddingModel embeddingModel, RagRepository repository) {
    this.embeddingModel = embeddingModel;
    this.repository = repository;
  }

  // -------- Index -------- //

  @Transactional
  public int index(RagIndexRequest request) {
    if (request.chunks().size() > MAX_CHUNKS_PER_REQUEST) {
      throw new CodePilotException(
          ErrorCodes.BAD_REQUEST,
          "Too many chunks in a single request (max " + MAX_CHUNKS_PER_REQUEST + ").");
    }

    // 1. Validate content sizes
    List<String> texts = new ArrayList<>(request.chunks().size());
    for (RagIndexRequest.ChunkPayload cp : request.chunks()) {
      String content = cp.content() == null ? "" : cp.content();
      if (content.getBytes(StandardCharsets.UTF_8).length > MAX_CHUNK_CONTENT_BYTES) {
        throw new CodePilotException(
            ErrorCodes.BAD_REQUEST, "Chunk content exceeds 32 KB limit: " + cp.path());
      }
      texts.add(content);
    }

    // 2. Compute embeddings in batches (max 64 per API call)
    List<float[]> allEmbeddings = computeEmbeddingsBatched(texts);

    // 3. Build RagChunk records
    List<RagChunk> chunks = new ArrayList<>(request.chunks().size());
    for (int i = 0; i < request.chunks().size(); i++) {
      RagIndexRequest.ChunkPayload cp = request.chunks().get(i);
      String content = cp.content() == null ? "" : cp.content();
      chunks.add(
          new RagChunk(
              request.sessionId(),
              request.userId(),
              cp.path(),
              cp.lang(),
              cp.startLine(),
              cp.endLine(),
              sha256(content),
              content.length() > 4096 ? content.substring(0, 4096) : content,
              allEmbeddings.get(i)));
    }

    // 4. Batch insert (partition into 1000-row batches for DB safety)
    for (List<RagChunk> batch : Lists.partition(chunks, 1000)) {
      repository.batchInsert(batch);
    }

    log.info(
        "Indexed {} chunks for session={} user={}",
        chunks.size(),
        request.sessionId(),
        request.userId());
    return chunks.size();
  }

  // -------- Search -------- //

  public RagSearchResponse search(RagSearchRequest request) {
    float[] queryEmbedding = computeSingleEmbedding(request.query());
    List<RagSearchHit> hits =
        repository.search(request.sessionId(), queryEmbedding, request.effectiveTopK());
    int total = repository.countBySession(request.sessionId());
    List<RagSearchResponse.Hit> results =
        hits.stream()
            .map(
                h ->
                    new RagSearchResponse.Hit(
                        h.path(), h.lang(), h.startLine(), h.endLine(), h.snippet(), h.score()))
            .toList();
    return new RagSearchResponse(results, total);
  }

  // -------- Delete -------- //

  @Transactional
  public int deleteBySession(UUID sessionId) {
    int deleted = repository.deleteBySession(sessionId);
    log.info("Deleted {} chunks for session={}", deleted, sessionId);
    return deleted;
  }

  // -------- Private helpers -------- //

  private List<float[]> computeEmbeddingsBatched(List<String> texts) {
    List<float[]> result = new ArrayList<>(texts.size());
    for (List<String> batch : Lists.partition(texts, EMBEDDING_BATCH_SIZE)) {
      EmbeddingResponse response = embeddingModel.embedForResponse(batch);
      response.getResults().forEach(e -> result.add(e.getOutput()));
    }
    return result;
  }

  private float[] computeSingleEmbedding(String text) {
    EmbeddingResponse response = embeddingModel.embedForResponse(List.of(text));
    return response.getResults().getFirst().getOutput();
  }

  private static String sha256(String input) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(hash);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 not available", e);
    }
  }
}