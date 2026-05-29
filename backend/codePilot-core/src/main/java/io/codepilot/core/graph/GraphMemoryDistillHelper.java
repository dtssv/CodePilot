package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.memory.MemoryLayer;
import io.codepilot.core.memory.MemoryType;
import io.codepilot.core.memory.ProtectionLevel;
import io.codepilot.core.memory.StructuredMemory;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * LLM-first memory candidate extraction from gathered phase context; falls back to
 * {@link MemoryContentClassifier} when the model call fails.
 */
@Component
public class GraphMemoryDistillHelper {

  private static final Logger log = LoggerFactory.getLogger(GraphMemoryDistillHelper.class);
  private static final int MAX_LLM_CANDIDATES = 5;
  private static final int MAX_RULE_CANDIDATES = 3;

  private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
  private final PromptRegistry promptRegistry;
  private final ObjectMapper mapper;

  public GraphMemoryDistillHelper(
      GraphAuxiliaryModelResolver auxiliaryModelResolver,
      PromptRegistry promptRegistry,
      ObjectMapper mapper) {
    this.auxiliaryModelResolver = auxiliaryModelResolver;
    this.promptRegistry = promptRegistry;
    this.mapper = mapper;
  }

  @SuppressWarnings("unchecked")
  public List<StructuredMemory> distillCandidates(
      OverAllState state, Map<String, Object> gathered, String phaseId) {
    if (gathered == null || gathered.isEmpty()) {
      return List.of();
    }
    try {
      List<StructuredMemory> fromLlm = distillWithLlm(state, gathered, phaseId);
      if (!fromLlm.isEmpty()) {
        return fromLlm;
      }
    } catch (Exception e) {
      log.warn("GraphMemoryDistillHelper: LLM distill failed, using rule fallback: {}", e.getMessage());
    }
    return MemoryContentClassifier.classifyAll(gathered, phaseId, MAX_RULE_CANDIDATES);
  }

  @SuppressWarnings("unchecked")
  private List<StructuredMemory> distillWithLlm(
      OverAllState state, Map<String, Object> gathered, String phaseId) throws Exception {
    String template = promptRegistry.get("graph.memoryDistill-gather");
    if (template == null || template.isBlank()) {
      return List.of();
    }
    String input = (String) state.value("input").orElse("");
    String gatheredText = GatheredInfoFormatter.format(gathered);
    if (gatheredText.length() > 12000) {
      gatheredText = gatheredText.substring(0, 12000) + "\n...(truncated)";
    }
    String prompt =
        template
            .replace("{{phaseId}}", phaseId)
            .replace("{{input}}", abbreviate(input, 500))
            .replace("{{gathered}}", gatheredText);

    String response = auxiliaryModelResolver.completeUserPrompt(state, "memory-distill", prompt);

    return parseCandidates(response, phaseId);
  }

  private List<StructuredMemory> parseCandidates(String response, String phaseId) throws Exception {
    String json = LlmJsonExtract.parseableJson(response);
    JsonNode root = mapper.readTree(json);
    JsonNode arr = root.get("candidates");
    if (arr == null || !arr.isArray()) {
      return List.of();
    }
    List<StructuredMemory> out = new ArrayList<>();
    for (JsonNode node : arr) {
      if (out.size() >= MAX_LLM_CANDIDATES) {
        break;
      }
      StructuredMemory m = toMemory(node, phaseId);
      if (m != null) {
        out.add(m);
      }
    }
    return out;
  }

  private StructuredMemory toMemory(JsonNode node, String phaseId) {
    String summary = node.path("summary").asText("").trim();
    if (summary.isBlank()) {
      return null;
    }
    MemoryLayer layer = parseEnum(node.path("layer").asText("SHORT_TERM"), MemoryLayer.class, MemoryLayer.SHORT_TERM);
    ProtectionLevel protection =
        parseEnum(node.path("protection").asText("PROTECTED"), ProtectionLevel.class, ProtectionLevel.PROTECTED);
    MemoryType type = parseEnum(node.path("type").asText("FACT"), MemoryType.class, MemoryType.FACT);
    String detail = node.path("detail").asText("").trim();
    if (detail.length() > 1000) {
      detail = detail.substring(0, 1000) + "...";
    }
    List<String> tags = new ArrayList<>();
    JsonNode tagsNode = node.get("tags");
    if (tagsNode != null && tagsNode.isArray()) {
      for (JsonNode t : tagsNode) {
        String tag = t.asText("").trim();
        if (!tag.isBlank()) {
          tags.add(tag);
        }
      }
    }
    tags.add(phaseId);
    return StructuredMemory.of(layer, protection, type, summary, detail.isBlank() ? null : detail, tags, phaseId);
  }

  private static <E extends Enum<E>> E parseEnum(String raw, Class<E> type, E fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    try {
      return Enum.valueOf(type, raw.trim().toUpperCase().replace('-', '_'));
    } catch (IllegalArgumentException e) {
      return fallback;
    }
  }

  private static String abbreviate(String s, int max) {
    if (s == null) {
      return "";
    }
    return s.length() > max ? s.substring(0, max) + "..." : s;
  }
}
