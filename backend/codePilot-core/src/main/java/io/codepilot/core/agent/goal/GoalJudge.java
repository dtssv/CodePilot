package io.codepilot.core.agent.goal;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.session.Message;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;

/**
 * Independent judge that evaluates whether a goal condition is truly satisfied.
 *
 * <p>goal evaluation system: when the agent tries
 * to stop, an independent LLM call evaluates the conversation to decide
 * whether the goal condition is truly met — preventing premature "optimistic
 * stops" during autonomous work.
 *
 * <p>The judge uses a fast, cheaper model (not the main reasoning model)
 * to keep latency and cost low. It receives a summary of the conversation
 * and the goal condition, then returns a structured verdict.
 *
 * <p>Verdict structure:
 * <pre>
 * {
 *   "satisfied": true|false,
 *   "confidence": 0.0-1.0,
 *   "reason": "explanation of why the goal is/isn't satisfied",
 *   "remainingWork": "what still needs to be done (if not satisfied)"
 * }
 * </pre>
 */
@Component
public class GoalJudge {

    private static final Logger log = LoggerFactory.getLogger(GoalJudge.class);

    private static final String JUDGE_PROMPT = """
            You are an impartial judge evaluating whether an AI coding agent has completed its assigned goal.
            
            ## Goal
            %s
            
            ## Success Criteria
            %s
            
            ## Conversation Summary
            The agent has made %d turns, read %d files, written %d files, and executed %d tool calls.
            
            %s
            
            ## Your Task
            Evaluate whether the goal has been FULLY satisfied based on the evidence above.
            Be strict — partial completion does NOT count as satisfied.
            
            Return a JSON object with:
            - "satisfied": true only if the goal is fully complete
            - "confidence": your confidence level (0.0 to 1.0)
            - "reason": brief explanation of your verdict
            - "remainingWork": what still needs to be done (empty string if satisfied)
            """;

    private final ChatClientFactory chatClientFactory;
    private final ObjectMapper mapper;

    public GoalJudge(ChatClientFactory chatClientFactory, ObjectMapper mapper) {
        this.chatClientFactory = chatClientFactory;
        this.mapper = mapper;
    }

    /**
     * Evaluates whether the goal condition in the agent state is satisfied.
     *
     * @return the verdict, or null if evaluation fails
     */
    public Verdict evaluate(
            String modelId,
            String modelSource,
            String userId,
            String goalCondition,
            int turnCount,
            int filesRead,
            int filesWritten,
            List<Message> messages) {
        return evaluateAsync(modelId, modelSource, userId, goalCondition, turnCount, filesRead, filesWritten, messages)
                .block();
    }

    /**
     * Reactive version of {@link #evaluate} — safe to call from a reactor pipeline.
     * The blocking LLM call is shifted onto a bounded-elastic scheduler.
     */
    public Mono<Verdict> evaluateAsync(
            String modelId,
            String modelSource,
            String userId,
            String goalCondition,
            int turnCount,
            int filesRead,
            int filesWritten,
            List<Message> messages) {

        if (goalCondition == null || goalCondition.isBlank()) {
            return Mono.just(new Verdict(false, 0.3, "No goal condition set",
                    "Goal condition is empty — cannot verify task completion"));
        }

        GoalCondition goal = GoalCondition.parse(goalCondition);
        if (goal == null) {
            return Mono.just(new Verdict(false, 0.3, "Goal condition could not be parsed",
                    "Goal condition is invalid — cannot verify task completion"));
        }

        // Fast-path heuristic: if the agent has made multiple turns but produced zero
        // observable output (no files read/written and all tool results are failures),
        // the goal is definitely NOT satisfied — no need to call the LLM judge.
        if (turnCount > 1 && filesRead == 0 && filesWritten == 0 && allToolResultsFailed(messages)) {
            log.info("GoalJudge fast-path: agent produced no observable output after {} turns", turnCount);
            return Mono.just(new Verdict(false, 0.9,
                    "Agent has not produced any observable output (0 files read, 0 files written, all tool calls failed)",
                    "All tool calls failed — the agent could not execute any actions"));
        }

        String conversationSummary = buildConversationSummary(messages);
        int toolCallCount = countToolCalls(messages);
        String prompt = String.format(JUDGE_PROMPT,
                goal.rawGoal(),
                goal.successCriteria().isBlank() ? "(none specified)" : goal.successCriteria(),
                turnCount,
                filesRead,
                filesWritten,
                toolCallCount,
                conversationSummary);

        return Mono.fromCallable(() -> {
                    ModelSource source = modelSource != null ? ModelSource.valueOf(modelSource) : ModelSource.GROUP;
                    var resolved = chatClientFactory.resolve(modelId, source, userId);
                    return resolved.chatClient()
                            .prompt()
                            .user(prompt)
                            .call()
                            .content();
                })
                .subscribeOn(Schedulers.boundedElastic())
                .map(this::parseVerdict)
                .onErrorResume(e -> {
                    log.warn("GoalJudge evaluation failed: {}", e.getMessage());
                    return Mono.just(new Verdict(false, 0.5, "Judge evaluation failed: " + e.getMessage(),
                            "Could not verify goal completion"));
                });
    }

    /**
     * Check whether all tool results in the conversation are failures (timed out or errored).
     * If so, the agent has produced no useful work regardless of what the LLM claims.
     */
    private boolean allToolResultsFailed(List<Message> messages) {
        boolean hasToolResults = false;
        boolean hasSuccessfulResult = false;
        for (Message msg : messages) {
            if (msg.role() == Message.Role.TOOL) {
                hasToolResults = true;
                String content = msg.content() != null ? msg.content() : "";
                if (!content.contains("timed out") && !content.contains("failed")
                        && !content.contains("error") && !content.contains("denied")) {
                    hasSuccessfulResult = true;
                }
            }
        }
        return hasToolResults && !hasSuccessfulResult;
    }

    private String buildConversationSummary(List<Message> messages) {
        StringBuilder sb = new StringBuilder();
        sb.append("### Recent Actions\n");
        int start = Math.max(0, messages.size() - 10);
        for (int i = start; i < messages.size(); i++) {
            Message msg = messages.get(i);
            String role = msg.role().name();
            String content = msg.content() != null ? msg.content() : "";
            if (content.length() > 200) {
                content = content.substring(0, 200) + "...";
            }
            sb.append("- [").append(role).append("] ").append(content).append("\n");
        }
        return sb.toString();
    }

    private int countToolCalls(List<Message> messages) {
        int count = 0;
        for (Message msg : messages) {
            if (msg.toolCalls() != null) {
                count += msg.toolCalls().size();
            }
        }
        return count;
    }

    private Verdict parseVerdict(String response) {
        try {
            String json = extractJson(response);
            JsonNode root = mapper.readTree(json);
            boolean satisfied = root.path("satisfied").asBoolean(false);
            double confidence = root.path("confidence").asDouble(0.5);
            String reason = root.path("reason").asText("");
            String remainingWork = root.path("remainingWork").asText("");
            return new Verdict(satisfied, confidence, reason, remainingWork);
        } catch (Exception e) {
            log.warn("GoalJudge: failed to parse verdict: {}", e.getMessage());
            return new Verdict(false, 0.5, "Failed to parse judge verdict", "Unknown");
        }
    }

    /**
     * Extract JSON from an LLM response that may contain markdown code fences
     * or prose around the JSON object.
     */
    private static String extractJson(String response) {
        if (response == null || response.isBlank()) {
            return response;
        }
        String text = response.trim();
        // Strip markdown code fences: ```json ... ``` or ``` ... ```
        if (text.contains("```")) {
            int start = text.indexOf("```");
            int contentStart = text.indexOf('\n', start);
            if (contentStart < 0) contentStart = start + 3;
            else contentStart++;
            int end = text.indexOf("```", contentStart);
            if (end > contentStart) {
                text = text.substring(contentStart, end).trim();
            }
        }
        // Find the first { and last } to extract the JSON object
        int firstBrace = text.indexOf('{');
        int lastBrace = text.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            text = text.substring(firstBrace, lastBrace + 1);
        }
        return text;
    }

    /**
     * The verdict from the goal judge.
     */
    public record Verdict(boolean satisfied, double confidence, String reason, String remainingWork) {
        /**
         * Returns true if the goal is NOT satisfied and the agent should continue.
         */
        public boolean shouldContinue() {
            return !satisfied;
        }
    }
}