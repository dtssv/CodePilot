package io.codepilot.core.model;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration properties for built-in models.
 *
 * <p>Loaded from {@code codepilot.models.builtin} in application yaml.
 */
@ConfigurationProperties(prefix = "codepilot.models")
public class BuiltinModelsProperties {

  private List<BuiltinModelEntry> models = new ArrayList<>();

  public List<BuiltinModelEntry> getModels() {
    return models;
  }

  public void setModels(List<BuiltinModelEntry> models) {
    this.models = models;
  }

  /** A single built-in model entry from config. */
  public static class BuiltinModelEntry {
    private String id;
    private String name;
    private List<String> caps = List.of();
    private int maxTokens = 128000;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public List<String> getCaps() { return caps; }
    public void setCaps(List<String> caps) { this.caps = caps; }
    public int getMaxTokens() { return maxTokens; }
    public void setMaxTokens(int maxTokens) { this.maxTokens = maxTokens; }
  }
}