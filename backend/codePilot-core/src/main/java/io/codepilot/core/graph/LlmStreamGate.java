package io.codepilot.core.graph;

import java.util.function.Consumer;

/**
 * Suppresses streaming of structured JSON envelopes to the chat UI while still
 * accumulating the full response for parsing.
 */
final class LlmStreamGate {

  private final StringBuilder acc = new StringBuilder();

  boolean offerChunk(String chunk, Consumer<String> emit) {
    if (chunk == null || chunk.isBlank()) {
      return false;
    }
    acc.append(chunk);
    if (looksLikeJsonEnvelope()) {
      return false;
    }
    emit.accept(chunk);
    return true;
  }

  private boolean looksLikeJsonEnvelope() {
    String trimmed = acc.toString().stripLeading();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }
}
