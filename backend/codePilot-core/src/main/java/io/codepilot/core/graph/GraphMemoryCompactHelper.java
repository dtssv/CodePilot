package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.memory.ProtectionLevel;
import io.codepilot.core.memory.StructuredMemory;
import io.codepilot.core.prompt.PromptRegistry;
import io.codepilot.core.run.GraphEngineProperties;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * LLM-assisted compaction of DEGRADABLE/VOLATILE memories; falls back to mechanical merge.
 */
@Component
public class GraphMemoryCompactHelper {

  private static final Logger log = LoggerFactory.getLogger(GraphMemoryCompactHelper.class);

  private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
  private final PromptRegistry promptRegistry;
  private final ObjectMapper mapper;
  private final GraphEngineProperties graphProperties;

  public GraphMemoryCompactHelper(
      GraphAuxiliaryModelResolver auxiliaryModelResolver,
      PromptRegistry promptRegistry,
      ObjectMapper mapper,
      GraphEngineProperties graphProperties) {
    this.auxiliaryModelResolver = auxiliaryModelResolver;
    this.promptRegistry = promptRegistry;
    this.mapper = mapper;
    this.graphProperties = graphProperties;
  }

  public record CompactResult(List<StructuredMemory> activeMemories, String compactedSummary) {}

  @SuppressWarnings("unchecked")
  public CompactResult compact(OverAllState state, String phaseId, List<StructuredMemory> allMemories) {
    List<StructuredMemory> preserved = new ArrayList<>();
    List<StructuredMemory> toCompress = new ArrayList<>();
    for (var m : allMemories) {
      if (m.protection() == ProtectionLevel.IMMORTAL || m.protection() == ProtectionLevel.PROTECTED) {
        preserved.add(m);
      } else {
        toCompress.add(m);
      }
    }
    if (toCompress.isEmpty()) {
      return new CompactResult(allMemories, null);
    }

    String summary = compactWithLlm(state, phaseId, preserved, toCompress);
    if (summary == null || summary.isBlank()) {
      summary = mechanicalSummary(toCompress, phaseId);
    }

    StructuredMemory compacted =
        StructuredMemory.of(
            io.codepilot.core.memory.MemoryLayer.SHORT_TERM,
            ProtectionLevel.PROTECTED,
            io.codepilot.core.memory.MemoryType.FACT,
            "Compacted context from " + toCompress.size() + " memories (phase " + phaseId + ")",
            summary,
            List.of("compacted", "phase-" + phaseId),
            phaseId);

    List<StructuredMemory> merged = new ArrayList<>(preserved);
    merged.add(compacted);
    return new CompactResult(merged, summary);
  }

  private String compactWithLlm(
      OverAllState state,
      String phaseId,
      List<StructuredMemory> preserved,
      List<StructuredMemory> toCompress) {
    String template = promptRegistry.get("graph.memoryCompact-llm");
    if (template == null || template.isBlank()) {
      return null;
    }
    int maxChars = Math.max(graphProperties.getMemoryBudget() * 2, 4000);
    StringBuilder memText = new StringBuilder();
    for (var m : preserved) {
      memText.append("[PRESERVE ").append(m.protection()).append("] ").append(m.id()).append(": ");
      memText.append(m.summary());
      if (m.detail() != null && !m.detail().isBlank()) {
        memText.append(" | ").append(abbreviate(m.detail(), 400));
      }
      memText.append("\n");
    }
    for (var m : toCompress) {
      memText.append("[COMPRESS ").append(m.protection()).append("] ").append(m.id()).append(": ");
      memText.append(m.summary()).append("\n");
    }
    String prompt =
        template
            .replace("{{phaseId}}", phaseId)
            .replace("{{memories}}", memText.toString())
            .replace("{{maxChars}}", String.valueOf(maxChars));
    try {
      String response = auxiliaryModelResolver.completeUserPrompt(state, "memory-compact", prompt);
      String json = LlmJsonExtract.parseableJson(response);
      JsonNode root = mapper.readTree(json);
      String summary = root.path("summary").asText("").trim();
      if (!summary.isBlank()) {
        log.info("GraphMemoryCompactHelper: LLM compact produced {} chars for phase {}", summary.length(), phaseId);
        return summary;
      }
    } catch (Exception e) {
      log.warn("GraphMemoryCompactHelper: LLM compact failed: {}", e.getMessage());
    }
    return null;
  }

  private static String mechanicalSummary(List<StructuredMemory> toCompress, String phaseId) {
    StringBuilder summaryBuilder = new StringBuilder();
    summaryBuilder
        .append("[COMPACTED CONTEXT — ")
        .append(toCompress.size())
        .append(" memories compressed at phase ")
        .append(phaseId)
        .append("]\n");
    for (var m : toCompress) {
      summaryBuilder.append("- [").append(m.type()).append("] ").append(m.summary());
      if (m.detail() != null && !m.detail().isBlank()) {
        String detail = m.detail().length() > 200 ? m.detail().substring(0, 200) + "..." : m.detail();
        summaryBuilder.append(" | ").append(detail);
      }
      summaryBuilder.append("\n");
    }
    return summaryBuilder.toString();
  }

  private static String abbreviate(String s, int max) {
    return s.length() > max ? s.substring(0, max) + "..." : s;
  }
}
