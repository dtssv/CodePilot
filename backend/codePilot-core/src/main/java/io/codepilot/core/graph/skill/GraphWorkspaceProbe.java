package io.codepilot.core.graph.skill;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.skill.WorkspaceProbe;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Builds a {@link WorkspaceProbe.Probe} from graph state (projectMeta + input). */
public final class GraphWorkspaceProbe {

    private static final Pattern LANG_LINE =
            Pattern.compile("(?i)languages?\\s*:\\s*([^\\n]+)");
    private static final Pattern ROOT_ENTRY =
            Pattern.compile("(?m)^\\s*[-•]?\\s*([\\w./\\-]+/?)\\s*$");

    private GraphWorkspaceProbe() {}

    public static WorkspaceProbe.Probe fromState(OverAllState state, GraphSkillNode node) {
        String input = (String) state.value("input").orElse("");
        String projectMeta = (String) state.value("projectMeta").orElse("");
        String mode = (String) state.value("mode").orElse("AGENT");

        Set<String> languages = new LinkedHashSet<>();
        Set<String> frameworks = new LinkedHashSet<>();
        Set<String> filePaths = new LinkedHashSet<>();
        Set<String> keywords = new LinkedHashSet<>();

        mineText(projectMeta, languages, frameworks, keywords);
        mineText(input, languages, frameworks, keywords);
        parseLanguagesLine(projectMeta, languages);
        parseRootEntries(projectMeta, filePaths);

        String action = detectAction(input, node);
        ConversationMode convMode =
                "CHAT".equalsIgnoreCase(mode) ? ConversationMode.CHAT : ConversationMode.AGENT;
        return new WorkspaceProbe.Probe(
                convMode, action, Set.copyOf(languages), Set.copyOf(frameworks),
                Set.copyOf(filePaths), Set.copyOf(keywords));
    }

    private static String detectAction(String input, GraphSkillNode node) {
        String lower = input == null ? "" : input.toLowerCase(Locale.ROOT);
        for (String hint : node.actionHints()) {
            if (lower.contains(hint.toLowerCase(Locale.ROOT))) {
                return hint;
            }
        }
        return node.name().toLowerCase(Locale.ROOT);
    }

    private static void parseLanguagesLine(String meta, Set<String> languages) {
        if (meta == null || meta.isBlank()) return;
        var m = LANG_LINE.matcher(meta);
        if (!m.find()) return;
        for (String part : m.group(1).split("[,;|]")) {
            String lang = part.trim().toLowerCase(Locale.ROOT);
            if (!lang.isBlank()) {
                languages.add(lang);
                if (lang.contains("java")) languages.add("java");
                if (lang.contains("kotlin")) languages.add("kotlin");
                if (lang.contains("python")) languages.add("python");
                if (lang.contains("typescript") || lang.contains("javascript")) {
                    languages.add("typescript");
                    languages.add("javascript");
                }
                if (lang.contains("go")) languages.add("go");
            }
        }
    }

    private static void parseRootEntries(String meta, Set<String> filePaths) {
        if (meta == null) return;
        var m = ROOT_ENTRY.matcher(meta);
        while (m.find()) {
            String entry = m.group(1).trim();
            if (!entry.isBlank()) {
                filePaths.add(entry);
            }
        }
        // Also pick obvious build files mentioned inline
        for (String marker :
                java.util.List.of("pom.xml", "build.gradle", "package.json", "go.mod", "Cargo.toml")) {
            if (meta.contains(marker)) {
                filePaths.add(marker);
            }
        }
    }

    private static void mineText(
            String text, Set<String> languages, Set<String> frameworks, Set<String> keywords) {
        if (text == null || text.isBlank()) return;
        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.contains("spring")) frameworks.add("spring");
        if (lower.contains("react")) frameworks.add("react");
        if (lower.contains("vue")) frameworks.add("vue");
        if (lower.contains(".java") || lower.contains("java ")) languages.add("java");
        if (lower.contains(".kt") || lower.contains("kotlin")) languages.add("kotlin");
        if (lower.contains(".py") || lower.contains("python")) languages.add("python");
        if (lower.contains(".ts") || lower.contains("typescript")) languages.add("typescript");
        if (lower.contains(".js") || lower.contains("javascript")) languages.add("javascript");
        if (lower.contains(".go") || lower.contains("golang")) languages.add("go");
        if (lower.contains("sql")) languages.add("sql");
        for (String word : lower.split("\\W+")) {
            if (word.length() >= 4) keywords.add(word);
        }
    }
}
