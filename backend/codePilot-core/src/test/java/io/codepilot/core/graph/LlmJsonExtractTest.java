package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class LlmJsonExtractTest {

  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void extractsJsonFromMarkdownFence() {
    String raw = "```json\n{\"a\":1}\n```";
    assertThat(LlmJsonExtract.extractJson(raw)).isEqualTo("{\"a\":1}");
  }

  @Test
  void sanitizesRawNewlinesInsideStrings() throws Exception {
    String broken = "{\"text\":\"line1\nline2\"}";
    String fixed = LlmJsonExtract.sanitizeControlChars(broken);
    var node = mapper.readTree(fixed);
    assertThat(node.get("text").asText()).isEqualTo("line1\nline2");
  }

  @Test
  void parseableJsonCombinesExtractAndSanitize() throws Exception {
    String raw = "Here is output:\n```\n{\"ok\":true,\"msg\":\"a\nb\"}\n```";
    String json = LlmJsonExtract.parseableJson(raw);
    assertThat(mapper.readTree(json).get("ok").asBoolean()).isTrue();
  }

  @Test
  void removesInvalidBacktickEscape() throws Exception {
    // LLM may output \` inside JSON string values — Jackson rejects it
    String raw = "{\"text\":\"hello \\`world\\`\"}";
    String json = LlmJsonExtract.sanitizeControlChars(raw);
    var node = mapper.readTree(json);
    assertThat(node.get("text").asText()).isEqualTo("hello `world`");
  }
}
