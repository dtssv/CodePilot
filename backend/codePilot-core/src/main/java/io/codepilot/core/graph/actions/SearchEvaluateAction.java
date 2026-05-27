package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.GatheredInfoFormatter;
import io.codepilot.core.graph.GraphExecutionLog;
import io.codepilot.core.graph.GraphLlmHelper;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.LlmJsonExtract;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.sse.SseEvents;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Search-Evaluate node for Deep Research graph template.
 *
 * <p>After each Gather round, this node asks the LLM to evaluate whether the
 * collected information is sufficient to answer the current research sub-question.
 *
 * <p>Possible outcomes (written to state["evaluateResult"]):
 * <ul>
 *   <li>{@code "sufficient"} → proceed to commit (move to next sub-question or synthesize)</li>
 *   <li>{@code "insufficient"} → generate more search queries and gather again</li>
 *   <li>{@code "askUser"} → ambiguous, need user clarification</li>
 * </ul>
 */
@Component
public class SearchEvaluateAction implements NodeAction {

    private static final int MAX_SEARCH_ROUNDS = 5;
    private final ChatClientFactory chatClientFactory;

    public SearchEvaluateAction(ChatClientFactory chatClientFactory) {
        this.chatClientFactory = chatClientFactory;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "searchEvaluate");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        int searchRound = (int) state.value("searchRound").orElse(0);

        // 1) Accumulate this gather round into state.gathered[]
        Map<String, Object> gatheredInfo =
            (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
        List<Map<String, Object>> gatheredAccum =
            (List<Map<String, Object>>) state.value("gathered").orElse(List.of());

        List<Map<String, Object>> nextAccum = new ArrayList<>(gatheredAccum);
        for (Object raw : gatheredInfo.values()) {
            if (raw instanceof Map<?, ?> m) {
                nextAccum.add((Map<String, Object>) m);
            }
        }
        updates.put("gathered", nextAccum);

        String goal = (String) state.value("input").orElse("");

        // Try to infer current sub-question from phase title
        String subQuestion = "";
        Object phaseTitleObj = "";
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> phases =
            (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        for (Map<String, Object> p : phases) {
            if (phaseId.equals(String.valueOf(p.get("id")))) {
                phaseTitleObj = p.getOrDefault("title", "");
                break;
            }
        }
        subQuestion = phaseTitleObj != null ? String.valueOf(phaseTitleObj) : "";

        // 2) Decide sufficient/insufficient/askUser with LLM
        String decision;
        String reason;

        if (searchRound >= MAX_SEARCH_ROUNDS) {
            decision = "sufficient";
            reason = "Reached maximum search rounds; proceed to next phase.";
        } else {
            String gatheredText = summarizeGathered(nextAccum, 18);

            String prompt =
                "You are the evaluator for a deep-research workflow.\n"
                    + "Goal (overall task): " + goal + "\n"
                    + "Current sub-question (current phase title): " + subQuestion + "\n\n"
                    + "Collected evidence so far:\n"
                    + gatheredText + "\n\n"
                    + "Decide whether the evidence is enough to progress for this sub-question.\n"
                    + "Return ONLY parseable JSON with this schema:\n"
                    + "{\n"
                    + "  \"decision\": \"sufficient\" | \"insufficient\" | \"askUser\",\n"
                    + "  \"reason\": string,\n"
                    + "  \"missing\": string[]\n"
                    + "}\n"
                    + "Rules:\n"
                    + "- sufficient: enough evidence to proceed.\n"
                    + "- insufficient: need more evidence; missing[] should include 1-3 concrete gaps.\n"
                    + "- askUser: the goal is ambiguous or conflicting; request clarification in missing[].\n";

            try {
                String modelId = (String) state.value("modelId").orElse(null);
                String modelSourceName = (String) state.value("modelSource").orElse(null);
                String userId = (String) state.value("userId").orElse(null);
                io.codepilot.core.model.ModelSource modelSource =
                    modelSourceName != null ? io.codepilot.core.model.ModelSource.valueOf(modelSourceName) : null;

                var resolved = chatClientFactory.resolve(modelId, modelSource, userId);
                GraphExecutionLog.llmRequest(state, "deep-research.evaluate", prompt);
                String response = GraphLlmHelper.completeUserPrompt(resolved, state, prompt);
                GraphExecutionLog.llmResponse(state, "deep-research.evaluate", response, Map.of());

                String json = LlmJsonExtract.parseableJson(response);
                ObjectMapper mapper = new ObjectMapper();
                JsonNode root = mapper.readTree(json);
                decision = root.path("decision").asText("sufficient");
                reason = root.path("reason").asText("");
                if (reason == null || reason.isBlank()) {
                    reason = "LLM evaluation returned no reason.";
                }
                // Normalize
                if (!"sufficient".equals(decision) && !"insufficient".equals(decision) && !"askUser".equals(decision)) {
                    decision = "sufficient";
                }
            } catch (Exception e) {
                // Non-fatal fallback
                boolean hasData = !nextAccum.isEmpty();
                decision = hasData ? "sufficient" : "insufficient";
                reason = "Deep-research evaluate failed; fallback decision=" + decision + " (" + e.getMessage() + ")";
            }
        }

        updates.put("evaluateResult", decision);
        updates.put("searchRound", searchRound + 1);

        // 3) Make commit/phase satisfaction consistent with deep-research's "search evidence".
        // Deep-research does not rely on IDE fs.read/verify, so treat sufficient evidence as analysis output.
        if ("sufficient".equals(decision)) {
            updates.put("phaseHasAnalysisOutput", true);
            updates.put("sessionHasSourceReads", true);
            updates.put("phaseToolsHadFailure", false);
        }

        // 4) Emit user-facing progress for the deep-research loop
        if ("sufficient".equals(decision)) {
            GraphSseHelper.emitEvent(
                state,
                SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", phaseId, "status", "completed", "message", "Search evidence is sufficient"));
        } else if ("insufficient".equals(decision)) {
            GraphSseHelper.emitEvent(
                state,
                SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", phaseId, "status", "in_progress", "message", "Need more evidence; expanding search"));
        } else if ("askUser".equals(decision)) {
            GraphSseHelper.emitEvent(
                state,
                SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", phaseId, "status", "in_progress", "message", "Need clarification from user"));
        }

        return updates;
    }

    private static String summarizeGathered(List<Map<String, Object>> entries, int maxItems) {
        if (entries == null || entries.isEmpty()) {
            return "(no gathered evidence yet)";
        }
        int n = Math.min(entries.size(), maxItems);
        StringBuilder sb = new StringBuilder();
        sb.append("[Accumulated evidence — ").append(entries.size()).append(" items total]\n");
        for (int i = 0; i < n; i++) {
            Map<String, Object> e = entries.get(i);
            String kind = String.valueOf(e.getOrDefault("kind", "unknown"));
            boolean ok = GatheredInfoFormatter.entrySucceeded(e);
            sb.append("- (").append(ok ? "OK" : "FAILED").append(") ").append(kind);
            Object id = e.getOrDefault("id", "");
            if (id != null && !String.valueOf(id).isBlank()) {
                sb.append(" id=").append(id);
            }
            Object result = e.get("result");
            if (result != null) {
                String asString = result.toString();
                if (asString.length() > 400) {
                    asString = asString.substring(0, 400) + "...";
                }
                sb.append(": ").append(asString);
            }
            sb.append("\n");
        }
        if (entries.size() > n) {
            sb.append("... (truncated)\n");
        }
        return sb.toString();
    }

    public String routeAfterEvaluate(OverAllState state) {
        String result = (String) state.value("evaluateResult").orElse("sufficient");
        return switch (result) {
            case "insufficient" -> "generate";   // back to generate more queries
            case "askUser" -> "askUser";
            default -> "commit";                  // sufficient → next sub-question
        };
    }
}