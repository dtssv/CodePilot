package io.codepilot.core.skill;

import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Service;

/**
 * Discovers, loads, and caches skills from multiple sources. Skill discovery
 * system.
 *
 * <p>Skill sources (in priority order):
 *
 * <ol>
 *   <li>Built-in skills (classpath:prompts/skill/*.md)
 *   <li>Project-local skills (.codepilot/skills/)
 *   <li>Plugin-reported skill directories
 * </ol>
 */
@Service
public class SkillService {

  private static final Logger log = LoggerFactory.getLogger(SkillService.class);
  private static final String BUILTIN_SKILL_PATTERN = "classpath:prompts/skill/*.md";

  private final Map<String, SkillInfo> skills = new ConcurrentHashMap<>();

  @PostConstruct
  public void init() {
    loadBuiltInSkills();
    log.info("SkillService initialized with {} built-in skills", skills.size());
  }

  public Optional<SkillInfo> get(String name) {
    return Optional.ofNullable(skills.get(name));
  }

  public List<SkillInfo> all() {
    return new ArrayList<>(skills.values());
  }

  /** Return skills available for a given agent (respecting hidden flag). */
  public List<SkillInfo> available(boolean includeHidden) {
    return skills.values().stream()
        .filter(s -> includeHidden || !s.hidden())
        .sorted(Comparator.comparing(SkillInfo::name))
        .toList();
  }

  /** Load skills from plugin-reported directories. */
  public void loadFromDirectories(List<String> dirs) {
    if (dirs == null) return;
    for (String dir : dirs) {
      loadFromDirectory(Path.of(dir));
    }
  }

  /** Load skills from a specific directory. */
  public void loadFromDirectory(Path dir) {
    if (!Files.isDirectory(dir)) return;
    try {
      Files.walkFileTree(
          dir,
          new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
              String name = file.getFileName().toString().toLowerCase();
              if (name.endsWith(".md")
                  && (name.startsWith("skill")
                      || name.equals("skill.md")
                      || !name.startsWith("."))) {
                try {
                  String content = Files.readString(file);
                  SkillInfo skill = SkillInfo.parse(content, file.toString());
                  skills.put(skill.name(), skill);
                  log.debug("Loaded skill '{}' from {}", skill.name(), file);
                } catch (IOException e) {
                  log.warn("Failed to read skill file {}", file, e);
                }
              }
              return FileVisitResult.CONTINUE;
            }
          });
    } catch (IOException e) {
      log.warn("Failed to scan skill directory {}", dir, e);
    }
  }

  /** Load built-in skills from classpath. */
  private void loadBuiltInSkills() {
    var resolver = new PathMatchingResourcePatternResolver();
    try {
      Resource[] resources = resolver.getResources(BUILTIN_SKILL_PATTERN);
      for (Resource resource : resources) {
        try {
          String content = resource.getContentAsString(StandardCharsets.UTF_8);
          String filename = resource.getFilename();
          SkillInfo skill = SkillInfo.parse(content, "builtin:" + filename);
          skills.put(skill.name(), skill);
          log.debug("Loaded built-in skill '{}' from {}", skill.name(), filename);
        } catch (IOException e) {
          log.warn("Failed to read built-in skill resource", e);
        }
      }
    } catch (IOException e) {
      // Directory doesn't exist yet — that's normal, nothing to load
      log.debug("No built-in skills directory found (normal on first run): {}", e.getMessage());
    }
  }

  /** Format available skills for injection into the system prompt. */
  public String formatForPrompt() {
    List<SkillInfo> available = available(false);
    if (available.isEmpty()) return "";
    StringBuilder sb = new StringBuilder();
    sb.append("# Available Skills\n\n");
    sb.append("You can invoke skills using the `skill` tool. ");
    sb.append("Each skill provides a structured workflow.\n\n");
    for (SkillInfo skill : available) {
      sb.append("- **").append(skill.name()).append("**: ");
      sb.append(skill.description()).append("\n");
    }
    sb.append("\nTo use a skill, call: `skill({\"name\": \"<skill_name>\"})`\n");
    return sb.toString();
  }
}
