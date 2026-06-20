package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.run.GraphEngineProperties;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Resolves a lightweight model for auxiliary graph tasks (memory classify, context split,
 * planning, dynamic plan expand, search evaluate, intake intent, memory compact/distill).
 * Falls back to the session's primary model
 * when no auxiliary model is configured.
 */
@Component
public class GraphAuxiliaryModelResolver {

    private static final Logger log = LoggerFactory.getLogger(GraphAuxiliaryModelResolver.class);

    private final ChatClientFactory chatClientFactory;
    private final GraphEngineProperties graphProperties;
    private final GraphExecutionMetrics graphExecutionMetrics;

    public GraphAuxiliaryModelResolver(
            ChatClientFactory chatClientFactory,
            GraphEngineProperties graphProperties,
            GraphExecutionMetrics graphExecutionMetrics) {
        this.chatClientFactory = chatClientFactory;
        this.graphProperties = graphProperties;
        this.graphExecutionMetrics = graphExecutionMetrics;
    }

    public boolean usesDedicatedAuxiliaryModel() {
        String id = graphProperties.getAuxiliaryModelId();
        return id != null && !id.isBlank();
    }

    public ChatClientFactory.ResolvedClient resolve(OverAllState state) {
        if (usesDedicatedAuxiliaryModel()) {
            String userId = (String) state.value("userId").orElse(null);
            ModelSource source = parseModelSource(graphProperties.getAuxiliaryModelSource());
            log.debug(
                    "GraphAuxiliaryModelResolver: using auxiliary model id={} source={}",
                    graphProperties.getAuxiliaryModelId(),
                    source);
            return chatClientFactory.resolve(
                    graphProperties.getAuxiliaryModelId(), source, userId);
        }
        String modelId = (String) state.value("modelId").orElse(null);
        String modelSourceName = (String) state.value("modelSource").orElse(null);
        String userId = (String) state.value("userId").orElse(null);
        ModelSource modelSource =
                modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
        return chatClientFactory.resolve(modelId, modelSource, userId);
    }

    public String completeUserPrompt(OverAllState state, String action, String prompt) {
        long started = System.currentTimeMillis();
        GraphExecutionLog.llmRequest(state, action, prompt);
        var resolved = resolve(state);
        String response = GraphLlmHelper.completeUserPrompt(resolved, state, prompt);
        GraphExecutionLog.llmResponse(state, action, response, Map.of());
        recordLlmMetrics(state, action, started, prompt, response);
        return response;
    }

    public String streamUserPromptToSse(
            OverAllState state, String action, String prompt, Map<String, Object> updates) {
        long started = System.currentTimeMillis();
        var resolved = resolve(state);
        String response = GraphLlmHelper.streamUserPromptToSse(resolved, state, prompt, updates);
        recordLlmMetrics(state, action, started, prompt, response);
        return response;
    }

    private void recordLlmMetrics(
            OverAllState state, String action, long startedMs, String prompt, String response) {
        long durationMs = System.currentTimeMillis() - startedMs;
        int promptChars = prompt != null ? prompt.length() : 0;
        int responseChars = response != null ? response.length() : 0;
        boolean auxiliary = usesDedicatedAuxiliaryModel();
        GraphExecutionLog.llmComplete(
                state, action, durationMs, promptChars, responseChars, auxiliary);
        graphExecutionMetrics.recordLlmCall(action, auxiliary, durationMs, promptChars, responseChars);
    }

    private static ModelSource parseModelSource(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return ModelSource.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
