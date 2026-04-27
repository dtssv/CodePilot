package io.codepilot.core.prompt;

import com.google.common.io.Resources;
import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Loads built-in skeleton prompt segments from classpath. Segments are stored under
 * {@code classpath:/prompts/<name>.txt} and are loaded once at startup.
 *
 * <p>This registry never returns the prompt body to clients; it is consumed only by
 * {@link PromptOrchestrator}. See docs/04-Prompt模板.md §A for the language-policy contract.
 */
@Service
public class PromptRegistry {

  private static final Logger log = LoggerFactory.getLogger(PromptRegistry.class);

  private static final Set<String> REQUIRED =
      Set.of(
          "base.system",
          "agent.system",
          "agent.tools",
          "agent.compact",
          "agent.replan",
          "agent.userEdits",
          "agent.selfCheck",
          "agent.contextBudget",
          "agent.needsInput",
          "agent.riskNotice",
          "agent.repairLoop",
          "agent.resume",
          "agent.delivery",
          "guard.system",
          "chat.system");

  private final Map<String, String> segments = new LinkedHashMap<>();

  @PostConstruct
  void load() {
    for (String name : REQUIRED) {
      segments.put(name, loadOrThrow(name));
    }
    log.info("Loaded {} prompt segments", segments.size());
  }

  public String get(String name) {
    String body = segments.get(name);
    if (body == null) throw new IllegalStateException("Unknown prompt segment: " + name);
    return body;
  }

  private static String loadOrThrow(String name) {
    String resource = "prompts/" + name + ".txt";
    URL url = Thread.currentThread().getContextClassLoader().getResource(resource);
    if (url == null) {
      throw new IllegalStateException("Missing prompt resource: " + resource);
    }
    try {
      return Resources.toString(url, StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new IllegalStateException("Failed to load prompt: " + resource, e);
    }
  }
}