package io.codepilot.core.skill;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Loads every {@code classpath:/skills/*.yaml} into a frozen list of {@link SkillManifest}s on
 * startup. The registry is intentionally read-only after boot — hot-reload can be added later by
 * watching a config-repo if ops need it.
 *
 * <p>Malformed / unsupported manifests fail fast at startup so deployments don't ship with broken
 * Skills.
 */
@Component
public class SystemSkillLoader {

  private static final Logger log = LoggerFactory.getLogger(SystemSkillLoader.class);

  private final YAMLMapper yamlMapper = new YAMLMapper();
  private final List<SkillManifest> skills = new ArrayList<>();

  @PostConstruct
  void load() throws IOException {
    ClassLoader cl = Thread.currentThread().getContextClassLoader();
    Enumeration<URL> roots = cl.getResources("skills/");
    // We also scan a manifest file per well-known index (fallback to directory listing is tricky
    // from inside a shaded JAR, so deployers place an `index.txt` next to the yaml files).
    loadFromIndex(cl);
    while (roots.hasMoreElements()) {
      URL r = roots.nextElement();
      log.info("Discovering system skills under {}", r);
    }
    log.info("Loaded {} system Skill manifests", skills.size());
  }

  private void loadFromIndex(ClassLoader cl) throws IOException {
    try (InputStream idx = cl.getResourceAsStream("skills/index.txt")) {
      if (idx == null) {
        log.warn("No skills/index.txt found; no system skills will be loaded.");
        return;
      }
      String contents = new String(idx.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
      for (String line : contents.lines().toList()) {
        String file = line.trim();
        if (file.isEmpty() || file.startsWith("#")) continue;
        try (InputStream in = cl.getResourceAsStream("skills/" + file)) {
          if (in == null) {
            throw new IllegalStateException("Skill file missing: " + file);
          }
          SkillManifest skill = yamlMapper.readValue(in, SkillManifest.class);
          validate(skill, file);
          skills.add(skill);
        }
      }
    }
  }

  private void validate(SkillManifest s, String file) {
    if (s.id() == null || s.id().isBlank()) fail(file, "id missing");
    if (!"system".equalsIgnoreCase(s.source())) fail(file, "source must be 'system'");
    if (s.systemPrompt() == null || s.systemPrompt().isBlank())
      fail(file, "systemPrompt missing");
    if (s.category() == null) fail(file, "category missing");
  }

  private void fail(String file, String reason) {
    throw new IllegalStateException("skills/" + file + ": " + reason);
  }

  public List<SkillManifest> all() {
    return List.copyOf(skills);
  }
}