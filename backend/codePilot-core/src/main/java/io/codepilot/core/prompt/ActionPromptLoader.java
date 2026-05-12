package io.codepilot.core.prompt;

import com.google.common.io.Resources;
import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Loads and caches action prompt templates from {@code classpath:/prompts/action.<name>.txt}.
 * Provides template variable substitution using {{variable}} syntax.
 *
 * <p>Supported actions: refactor, review, comment, gentest, gendoc, commit-message,
 * inline-completion, bug-scan, inline-edit.
 *
 * <p>Templates are loaded lazily on first access and cached for the lifetime of the application.
 */
@Service
public class ActionPromptLoader {

  private static final Logger log = LoggerFactory.getLogger(ActionPromptLoader.class);
  private static final String PREFIX = "prompts/action.";

  private final Map<String, String> cache = new ConcurrentHashMap<>();

  @PostConstruct
  void init() {
    log.info("ActionPromptLoader initialized (lazy loading on first access)");
  }

  /**
   * Load an action prompt template by name, with template variable substitution.
   *
   * @param action the action name (e.g. "refactor", "inline-edit")
   * @param vars template variables to substitute (key → value); {{key}} in template → value
   * @return the resolved prompt string
   */
  public String load(String action, Map<String, String> vars) {
    String template = cache.computeIfAbsent(action, this::loadTemplate);
    if (template == null) {
      throw new IllegalStateException("No action prompt template found for: " + action);
    }
    return resolve(template, vars);
  }

  /**
   * Load an action prompt template by name without substitution.
   */
  public String loadRaw(String action) {
    return cache.computeIfAbsent(action, this::loadTemplate);
  }

  /**
   * Check if a prompt template exists for the given action.
   */
  public boolean exists(String action) {
    String resource = PREFIX + action + ".txt";
    URL url = Thread.currentThread().getContextClassLoader().getResource(resource);
    return url != null;
  }

  private String loadTemplate(String action) {
    String resource = PREFIX + action + ".txt";
    URL url = Thread.currentThread().getContextClassLoader().getResource(resource);
    if (url == null) {
      log.warn("No action prompt template found at {}, will use inline fallback", resource);
      return null;
    }
    try {
      return Resources.toString(url, StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new IllegalStateException("Failed to load action prompt: " + resource, e);
    }
  }

  /**
   * Simple {{key}} variable substitution. Does not handle nested {{}} or escaping.
   */
  private String resolve(String template, Map<String, String> vars) {
    if (vars == null || vars.isEmpty()) return template;
    String result = template;
    for (Map.Entry<String, String> entry : vars.entrySet()) {
      String placeholder = "{{" + entry.getKey() + "}}";
      String value = entry.getValue() != null ? entry.getValue() : "";
      result = result.replace(placeholder, value);
    }
    // Remove unresolved Mustache-style conditional blocks: {{#key}}...{{/key}}
    result = result.replaceAll("\\{\\{#\\w+}}.*?\\{\\{/\\w+}}", "");
    return result;
  }
}