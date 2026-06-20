package io.codepilot.core.session.prompt;

import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

/**
 * Loads classpath-backed prompt resources (agent behavior prompts, skill prompts) and caches their
 * content for the lifetime of the process.
 *
 * <p>Resource paths may be given with or without the {@code classpath:} prefix (e.g. {@code
 * prompts/agent/build.txt}). A failed or missing resource is cached as an empty result so we never
 * repeatedly hit the filesystem for a known miss.
 */
@Component
public class PromptResourceLoader {

  private static final Logger log = LoggerFactory.getLogger(PromptResourceLoader.class);

  private final PathMatchingResourcePatternResolver resolver =
      new PathMatchingResourcePatternResolver();
  private final ConcurrentHashMap<String, String> cache = new ConcurrentHashMap<>();

  /** Load a prompt resource, returning empty if it is missing or unreadable. */
  public Optional<String> load(String resourcePath) {
    if (resourcePath == null || resourcePath.isBlank()) {
      return Optional.empty();
    }
    String content = cache.computeIfAbsent(resourcePath, this::read);
    return content.isEmpty() ? Optional.empty() : Optional.of(content);
  }

  private String read(String resourcePath) {
    String location =
        resourcePath.startsWith("classpath:") ? resourcePath : "classpath:" + resourcePath;
    try {
      Resource res = resolver.getResource(location);
      if (!res.exists()) {
        log.warn("Prompt resource not found: {}", location);
        return "";
      }
      try (var in = res.getInputStream()) {
        return new String(in.readAllBytes(), StandardCharsets.UTF_8).strip();
      }
    } catch (Exception e) {
      log.warn("Failed to load prompt resource {}: {}", location, e.getMessage());
      return "";
    }
  }
}
