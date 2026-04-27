package io.codepilot.core.rag;

import javax.sql.DataSource;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.PgVectorStore;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Configures Spring AI {@link PgVectorStore} backed by the existing
 * {@code rag_chunks} table created in V2__pgvector.sql.
 *
 * <p>Uses the default OpenAI embedding model (text-embedding-ada-002, 1536 dims).
 * The table already has session-scoped isolation and 24h TTL via expires_at.
 */
@Configuration
public class PgVectorStoreConfig {

  @Bean
  public VectorStore vectorStore(DataSource dataSource, EmbeddingModel embeddingModel) {
    return PgVectorStore.builder(dataSource, embeddingModel)
        .dimensions(1536)
        .tableName("rag_chunks")
        .schemaName("public")
        .build();
  }
}