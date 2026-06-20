package io.codepilot.core.rag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.codepilot.common.api.CodePilotException;
import io.codepilot.core.rag.dto.RagIndexRequest;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.ai.embedding.Embedding;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.embedding.EmbeddingRequest;
import org.springframework.ai.embedding.EmbeddingResponse;

/**
 * Unit tests for {@link RagService}. Uses an in-memory mock of EmbeddingModel and RagRepository to
 * verify business logic without external dependencies.
 */
class RagServiceTest {

  private final UUID sessionId = UUID.randomUUID();
  private final UUID userId = UUID.randomUUID();

  @Test
  void index_rejectsOversizedChunks() {
    RagRepository repo = new FakeRagRepository();
    EmbeddingModel embedding = new FakeEmbeddingModel();
    RagService service = new RagService(embedding, repo);

    String largeContent = "x".repeat(33 * 1024); // exceeds 32KB
    var req =
        new RagIndexRequest(
            sessionId,
            userId,
            List.of(new RagIndexRequest.ChunkPayload("test.java", "java", 1, 10, largeContent)));

    assertThatThrownBy(() -> service.index(req))
        .isInstanceOf(CodePilotException.class)
        .hasMessageContaining("32 KB");
  }

  @Test
  void index_validChunks_storesSuccessfully() {
    FakeRagRepository repo = new FakeRagRepository();
    EmbeddingModel embedding = new FakeEmbeddingModel();
    RagService service = new RagService(embedding, repo);

    var req =
        new RagIndexRequest(
            sessionId,
            userId,
            List.of(
                new RagIndexRequest.ChunkPayload(
                    "Main.java", "java", 1, 20, "public class Main {}")));

    int indexed = service.index(req);
    assertThat(indexed).isEqualTo(1);
    assertThat(repo.stored).hasSize(1);
  }

  // -- Fakes for unit testing --

  private static class FakeRagRepository extends RagRepository {
    final List<RagChunk> stored = new java.util.ArrayList<>();

    FakeRagRepository() {
      super(null); // no JDBC needed for unit tests
    }

    @Override
    public void batchInsert(List<RagChunk> chunks) {
      stored.addAll(chunks);
    }

    @Override
    public List<RagSearchHit> search(UUID sessionId, float[] queryEmbedding, int topK) {
      return List.of();
    }

    @Override
    public int countBySession(UUID sessionId) {
      return stored.size();
    }
  }

  private static class FakeEmbeddingModel implements EmbeddingModel {
    @Override
    public float[] embed(org.springframework.ai.document.Document document) {
      return new float[1536];
    }

    @Override
    public EmbeddingResponse call(EmbeddingRequest request) {
      return embedForResponse(request.getInstructions());
    }

    @Override
    public EmbeddingResponse embedForResponse(List<String> texts) {
      List<Embedding> embeddings =
          texts.stream().map(t -> new Embedding(new float[1536], 0)).toList();
      return new EmbeddingResponse(embeddings);
    }
  }
}
