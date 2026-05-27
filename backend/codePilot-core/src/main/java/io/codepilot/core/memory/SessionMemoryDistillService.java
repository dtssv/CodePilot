package io.codepilot.core.memory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.GraphLlmHelper;
import io.codepilot.core.graph.LlmJsonExtract;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.model.ChatClientFactory.ResolvedClient;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Session-level memory distillation using {@code memory.distill.txt} when the user explicitly
 * opts in (记住 / remember / save memory).
 */
@Service
public class SessionMemoryDistillService {

  private static final Logger log = LoggerFactory.getLogger(SessionMemoryDistillService.class);

  private static final Pattern REMEMBER_TRIGGER =
      Pattern.compile(
          "(?i)(记住|保存记忆|save\\s+(?:this|that|to\\s+memory)|remember\\s+(?:this|that))",
          Pattern.UNICODE_CASE);

  private final ChatClientFactory chatClientFactory;
  private final PromptRegistry promptRegistry;
  private final ObjectMapper mapper;

  public SessionMemoryDistillService(
      ChatClientFactory chatClientFactory, PromptRegistry promptRegistry, ObjectMapper mapper) {
    this.chatClientFactory = chatClientFactory;
    this.promptRegistry = promptRegistry;
    this.mapper = mapper;
  }

  public boolean userRequestedMemoryPersistence(String input) {
    return input != null && REMEMBER_TRIGGER.matcher(input).find();
  }

  /**
   * Distill session memories when user opted in. Returns candidates ready for project persistence.
   */
  @SuppressWarnings("unchecked")
  public List<StructuredMemory> distillSession(
      String modelId,
      String modelSourceName,
      String userId,
      String projectRootHash,
      String sessionId,
      String userLocale,
      String latestInput,
      List<Map<String, String>> recentTurns,
      List<StructuredMemory> existingProjectMemories) {

    if (!userRequestedMemoryPersistence(latestInput)) {
      return List.of();
    }

    String template;
    try {
      template = promptRegistry.get("memory.distill");
    } catch (IllegalStateException e) {
      log.warn("SessionMemoryDistillService: memory.distill prompt not loaded");
      return List.of();
    }

    String existing = formatExistingMemories(existingProjectMemories);
    String turns = formatTurns(recentTurns);

    String prompt =
        template
            .replace("{{userLocale}}", userLocale != null ? userLocale : "zh")
            .replace("{{projectRootHash}}", projectRootHash != null ? projectRootHash : "")
            .replace("{{existingMemories}}", existing)
            .replace("{{recentTurns}}", turns);

    try {
      ModelSource modelSource =
          modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
      ResolvedClient resolved = chatClientFactory.resolve(modelId, modelSource, userId);
      String response = GraphLlmHelper.completeUserPrompt(resolved, null, prompt);
      return parseDistillResponse(response, sessionId);
    } catch (Exception e) {
      log.warn("SessionMemoryDistillService: distill failed (non-fatal): {}", e.getMessage());
      return List.of();
    }
  }

  private List<StructuredMemory> parseDistillResponse(String response, String sessionId)
      throws Exception {
    String json = LlmJsonExtract.parseableJson(response);
    JsonNode root = mapper.readTree(json);
    List<StructuredMemory> out = new ArrayList<>();

    JsonNode addNode = root.get("add");
    if (addNode != null && addNode.isArray()) {
      for (JsonNode item : addNode) {
        StructuredMemory m = fromDistillItem(item, sessionId);
        if (m != null) {
          out.add(m);
        }
      }
    }
    return out;
  }

  private StructuredMemory fromDistillItem(JsonNode item, String sessionId) {
    String text = item.path("text").asText("").trim();
    if (text.isBlank()) {
      return null;
    }
    String id = item.path("id").asText("session-" + System.currentTimeMillis());
    String kind = item.path("kind").asText("fact").toLowerCase(Locale.ROOT);
    MemoryType type =
        switch (kind) {
          case "preference" -> MemoryType.PREFERENCE;
          case "convention" -> MemoryType.DECISION;
          case "architecture", "skill-hint" -> MemoryType.ARCHITECTURE;
          default -> MemoryType.FACT;
        };
    ProtectionLevel protection =
        item.path("confidence").asDouble(0) >= 0.9
            ? ProtectionLevel.PROTECTED
            : ProtectionLevel.DEGRADABLE;
    List<String> tags = new ArrayList<>();
    tags.add("session");
    tags.add(sessionId);
    JsonNode evidence = item.get("evidence");
    if (evidence != null && evidence.isArray() && !evidence.isEmpty()) {
      tags.add("user-confirmed");
    }
    return StructuredMemory.of(
        MemoryLayer.LONG_TERM,
        protection,
        type,
        text,
        text,
        tags,
        sessionId);
  }

  private static String formatExistingMemories(List<StructuredMemory> memories) {
    if (memories == null || memories.isEmpty()) {
      return "(none)";
    }
    StringBuilder sb = new StringBuilder();
    for (StructuredMemory m : memories) {
      sb.append("- ").append(m.id()).append(": ").append(m.summary()).append("\n");
    }
    return sb.toString();
  }

  private static String formatTurns(List<Map<String, String>> turns) {
    if (turns == null || turns.isEmpty()) {
      return "(none)";
    }
    StringBuilder sb = new StringBuilder();
    int limit = Math.min(turns.size(), 20);
    for (int i = turns.size() - limit; i < turns.size(); i++) {
      Map<String, String> t = turns.get(i);
      sb.append("[")
          .append(t.getOrDefault("role", "user"))
          .append("] ")
          .append(t.getOrDefault("content", ""))
          .append("\n");
    }
    return sb.toString();
  }
}
