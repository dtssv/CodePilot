package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ContextShardRuleSplitterTest {

    @Test
    void splitsBySectionMarkersWithoutLlm() {
        String content =
                "=== USER REQUEST ===\n"
                        + "Fix the login bug in auth module.\n\n"
                        + "=== PROJECT CONTEXT ===\n"
                        + "## Database\n"
                        + "users table has email column.\n\n"
                        + "## API\n"
                        + "POST /login returns JWT.\n";

        var shards = ContextShardRuleSplitter.split(content, "input-ctx", 0, 120);
        assertThat(shards).hasSizeGreaterThanOrEqualTo(2);
        assertThat(ContextShardRuleSplitter.isViable(shards, content)).isTrue();
        assertThat(shards.stream().map(ContextShardStore.ContextShard::content).reduce("", String::concat))
                .contains("login bug")
                .contains("users table");
    }

    @Test
    void splitsOversizedParagraphsIntoMultipleShards() {
        StringBuilder large = new StringBuilder("=== USER REQUEST ===\n");
        for (int i = 0; i < 120; i++) {
            large.append("Line ").append(i).append(" with some padding text.\n");
        }
        String content = large.toString();

        var shards = ContextShardRuleSplitter.split(content, "input-ctx", 0, 1500);
        assertThat(shards.size()).isGreaterThanOrEqualTo(2);
        int totalChars =
                shards.stream().mapToInt(s -> s.content() != null ? s.content().length() : 0).sum();
        assertThat(totalChars).isGreaterThan((int) (content.length() * 0.7));
    }
}
