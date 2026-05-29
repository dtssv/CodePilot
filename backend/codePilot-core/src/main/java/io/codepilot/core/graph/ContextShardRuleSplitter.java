package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Deterministic context splitting — avoids an LLM call when structure is obvious
 * (section headers, markdown headings, paragraph boundaries).
 */
public final class ContextShardRuleSplitter {

    private static final Pattern SECTION_MARKER =
            Pattern.compile("(?m)^=== .+ ===\\s*$");
    private static final Pattern MARKDOWN_HEADING = Pattern.compile("(?m)^#{1,6} .+$");

    private ContextShardRuleSplitter() {}

    /**
     * Split {@code segment} into shards. Returns empty when rule split is not viable
     * (caller should fall back to LLM or fixed-size chunking).
     */
    public static List<ContextShardStore.ContextShard> split(
            String segment, String sourceId, int batchIdx, int targetChunkSize) {
        if (segment == null || segment.isBlank()) {
            return List.of();
        }
        int chunkSize = targetChunkSize > 0 ? targetChunkSize : 8000;
        List<String> sections = splitIntoSections(segment);
        if (sections.isEmpty()) {
            return List.of();
        }

        List<ContextShardStore.ContextShard> shards = new ArrayList<>();
        StringBuilder buffer = new StringBuilder();
        String bufferType = "text";
        List<String> bufferTags = List.of("context");
        int shardIdx = 0;

        for (String section : sections) {
            String type = inferContentType(section);
            List<String> tags = inferTags(section, type);

            if (buffer.length() > 0
                    && buffer.length() + section.length() > chunkSize
                    && buffer.length() >= chunkSize / 3) {
                shards.add(buildShard(sourceId, batchIdx, shardIdx++, buffer, bufferType, bufferTags));
                buffer = new StringBuilder();
                bufferType = type;
                bufferTags = tags;
            } else if (buffer.length() == 0) {
                bufferType = type;
                bufferTags = tags;
            }

            if (section.length() > chunkSize) {
                if (buffer.length() > 0) {
                    shards.add(buildShard(sourceId, batchIdx, shardIdx++, buffer, bufferType, bufferTags));
                    buffer = new StringBuilder();
                }
                for (String sub : splitOversizedSection(section, chunkSize)) {
                    shards.add(
                            buildShard(
                                    sourceId,
                                    batchIdx,
                                    shardIdx++,
                                    new StringBuilder(sub),
                                    type,
                                    tags));
                }
                bufferType = "text";
                bufferTags = List.of("context");
                continue;
            }

            buffer.append(section);
        }

        if (buffer.length() > 0) {
            shards.add(buildShard(sourceId, batchIdx, shardIdx, buffer, bufferType, bufferTags));
        }

        return shards;
    }

    /** True when rule split produced meaningful coverage without a single giant shard. */
    public static boolean isViable(List<ContextShardStore.ContextShard> shards, String segment) {
        if (shards == null || shards.isEmpty() || segment == null || segment.isBlank()) {
            return false;
        }
        if (shards.size() < 2) {
            return false;
        }
        int covered = shards.stream().mapToInt(s -> s.content() != null ? s.content().length() : 0).sum();
        return covered >= (int) (segment.length() * 0.7);
    }

    private static List<String> splitIntoSections(String text) {
        List<String> parts = splitByPattern(text, SECTION_MARKER);
        if (parts.size() <= 1) {
            parts = splitByPattern(text, MARKDOWN_HEADING);
        }
        if (parts.size() <= 1) {
            parts = splitByParagraphs(text);
        }
        return parts;
    }

    private static List<String> splitByPattern(String text, Pattern pattern) {
        List<Integer> positions = new ArrayList<>();
        Matcher m = pattern.matcher(text);
        while (m.find()) {
            positions.add(m.start());
        }
        if (positions.isEmpty()) {
            return List.of(text);
        }
        List<String> parts = new ArrayList<>();
        for (int i = 0; i < positions.size(); i++) {
            int start = positions.get(i);
            int end = i + 1 < positions.size() ? positions.get(i + 1) : text.length();
            parts.add(text.substring(start, end));
        }
        return parts.stream().filter(s -> !s.isBlank()).toList();
    }

    private static List<String> splitByParagraphs(String text) {
        String[] blocks = text.split("\\n\\n+");
        if (blocks.length <= 1) {
            return List.of(text);
        }
        List<String> parts = new ArrayList<>();
        for (String block : blocks) {
            if (!block.isBlank()) {
                parts.add(block);
            }
        }
        return parts.isEmpty() ? List.of(text) : parts;
    }

    private static List<String> splitOversizedSection(String section, int chunkSize) {
        List<String> chunks = new ArrayList<>();
        int offset = 0;
        while (offset < section.length()) {
            int end = Math.min(offset + chunkSize, section.length());
            if (end < section.length()) {
                int breakAt = section.lastIndexOf('\n', end);
                if (breakAt > offset + chunkSize / 2) {
                    end = breakAt + 1;
                }
            }
            chunks.add(section.substring(offset, end));
            offset = end;
        }
        return chunks;
    }

    private static ContextShardStore.ContextShard buildShard(
            String sourceId,
            int batchIdx,
            int shardIdx,
            StringBuilder content,
            String contentType,
            List<String> tags) {
        String text = content.toString();
        String summary =
                text.length() > 300 ? text.substring(0, 300) + "..." : text;
        Set<String> tagSet = new LinkedHashSet<>(tags);
        tagSet.add("rule-split");
        tagSet.add("batch-" + batchIdx);
        return new ContextShardStore.ContextShard(
                "rule_b" + batchIdx + "_" + shardIdx,
                sourceId,
                new ArrayList<>(tagSet),
                contentType,
                text,
                summary,
                java.util.Map.of("splitMethod", "rule", "batchIndex", batchIdx),
                text.length() / 4);
    }

    private static String inferContentType(String section) {
        if (section.contains("=== USER REQUEST ===")) {
            return "user_request";
        }
        if (section.contains("=== PROJECT CONTEXT ===")) {
            return "project_context";
        }
        if (section.contains("```")) {
            return "code";
        }
        if (MARKDOWN_HEADING.matcher(section).find()) {
            return "document_section";
        }
        return "text";
    }

    private static List<String> inferTags(String section, String contentType) {
        List<String> tags = new ArrayList<>();
        tags.add(contentType);
        if (section.contains("=== USER REQUEST ===")) {
            tags.add("user-request");
        }
        if (section.contains("=== PROJECT CONTEXT ===")) {
            tags.add("project-context");
        }
        if (section.contains("```")) {
            tags.add("code-block");
        }
        return tags;
    }
}
