package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import io.codepilot.core.run.GraphEngineProperties;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class GraphPromptContextBudgetTest {

    @Test
    void gatheredContextPrefersRecentEntriesWhenOverBudget() {
        Map<String, Object> gathered = new LinkedHashMap<>();
        gathered.put("old", Map.of("kind", "fs.read", "id", "old", "ok", true, "result", Map.of("path", "a.txt", "content", "x".repeat(8000))));
        gathered.put("new", Map.of("kind", "fs.read", "id", "new", "ok", true, "result", Map.of("path", "b.txt", "content", "recent-fix")));

        String out = GraphPromptContextBudget.gatheredContextSection(gathered, 500);
        assertThat(out).contains("[GATHERED CONTEXT]");
        assertThat(out).contains("recent-fix");
        assertThat(out).contains("omitted for prompt budget");
    }

    @Test
    void resolveBudgetsFromGraphProperties() {
        var props = new GraphEngineProperties();
        props.setGatheredInfoCharsBudget(24000);
        props.setMemoryBudget(6000);

        assertThat(GraphPromptContextBudget.resolveGenerateGatheredBudget(props)).isEqualTo(16000);
        assertThat(GraphPromptContextBudget.resolveGenerateProjectMetaBudget(props)).isEqualTo(8000);
        assertThat(GraphPromptContextBudget.resolveRepairPromptBudget(props)).isEqualTo(6000);
    }

    @Test
    void auxiliaryModelDefaultsAreUnset() {
        var props = new GraphEngineProperties();
        assertThat(props.getAuxiliaryModelId()).isBlank();
        assertThat(props.getGatherCacheTtlMinutes()).isEqualTo(30);
    }

    @Test
    void loopBudgetDefaultsAreTighter() {
        var props = new GraphEngineProperties();
        assertThat(props.getMaxGeneratePassesPerPhase()).isEqualTo(5);
        assertThat(props.getMaxPhaseFailureAttempts()).isEqualTo(4);
        assertThat(props.getMaxRepairAttemptsPerPhase()).isEqualTo(2);
    }
}
