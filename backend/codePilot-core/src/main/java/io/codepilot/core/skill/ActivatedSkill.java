package io.codepilot.core.skill;

import java.util.List;

/** Result of activation: identifying metadata + the segment text to inject into the system. */
public record ActivatedSkill(
    String id,
    String version,
    String source, // "system" | "user"
    String scope,  // "system" | "project" | "global"
    int priority,
    int tokens,
    List<String> permissionsTools,
    String systemPrompt) {}