package io.codepilot.core.agent.maxmode;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.session.SessionState;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.stereotype.Service;

/**
 * Max Mode — best-of-N plan sampling with an independent judge.
 *
 * <p>Before the main agent loop starts, Max Mode samples {@code N} candidate plans for the
 * task at a higher temperature (for diversity), then a low-temperature judge picks the
 * strongest plan. The winning plan is injected into the session so the main loop executes
 * the best-reasoned approach rather than the first one it happens to produce.
 *
 * <p> Max Mode (parallel best-of-N sampling + judge selection).
 */
@Service
public class MaxModeService {

  private static final Logger log = LoggerFactory.getLogger(MaxModeService.class);

  private static final String PLAN_PROMPT =
      """
      You are planning how to accomplish a software engineering task.
      Produce a concise, concrete, step-by-step plan (no code yet). Focus on the approach,
      the files likely involved, edge cases, and how you will verify success.
      """;

  private static final String JUDGE_PROMPT =
      """
      You are an impartial judge selecting the best engineering plan for a task.
      Evaluate the candidate plans for correctness, completeness, feasibility, and risk handling.
      Respond with ONLY a JSON object: {"best": <zero-based index>, "reason": "<short reason>"}.
      """;

  private final ChatClientFactory chatClientFactory;
  private final ObjectMapper mapper;

  public MaxModeService(ChatClientFactory chatClientFactory, ObjectMapper mapper) {
    this.chatClientFactory = chatClientFactory;
    this.mapper = mapper;
  }

  /**
   * Sample {@code n} candidate plans for the session's task and return the judged-best one.
   * Returns empty when fewer than two candidates could be produced.
   */
  public Optional<String> selectBestPlan(SessionState session, int n) {
    if (n < 2) return Optional.empty();
    String task = session.getInput();
    if (task == null || task.isBlank()) return Optional.empty();

    ChatClientFactory.ResolvedClient resolved;
    try {
      resolved = chatClientFactory.resolve(
          session.getModelId(),
          session.getModelSource() != null ? ModelSource.valueOf(session.getModelSource()) : ModelSource.GROUP,
          session.getUserId());
    } catch (Exception e) {
      log.warn("Max mode: failed to resolve client: {}", e.getMessage());
      return Optional.empty();
    }

    List<CompletableFuture<String>> futures = new ArrayList<>();
    for (int i = 0; i < n; i++) {
      futures.add(CompletableFuture.supplyAsync(() -> samplePlan(resolved, task)));
    }
    List<String> candidates = new ArrayList<>();
    for (var f : futures) {
      try {
        String c = f.get();
        if (c != null && !c.isBlank()) candidates.add(c);
      } catch (Exception e) {
        log.debug("Max mode: candidate sampling failed: {}", e.getMessage());
      }
    }

    if (candidates.isEmpty()) return Optional.empty();
    if (candidates.size() == 1) return Optional.of(candidates.get(0));

    int best = judge(resolved, task, candidates);
    log.info("Max mode: selected plan {} of {}", best + 1, candidates.size());
    return Optional.of(candidates.get(best));
  }

  private String samplePlan(ChatClientFactory.ResolvedClient resolved, String task) {
    try {
      var opts = OpenAiChatOptions.builder().temperature(0.9).maxTokens(1024).build();
      var resp = resolved.chatModel().call(
          new Prompt(List.of(new SystemMessage(PLAN_PROMPT), new UserMessage(task)), opts));
      return resp.getResult().getOutput().getText();
    } catch (Exception e) {
      log.debug("Plan sample failed: {}", e.getMessage());
      return null;
    }
  }

  private int judge(ChatClientFactory.ResolvedClient resolved, String task, List<String> candidates) {
    try {
      StringBuilder sb = new StringBuilder("## Task\n").append(task).append("\n\n## Candidate plans\n");
      for (int i = 0; i < candidates.size(); i++) {
        sb.append("\n### Plan ").append(i).append("\n").append(candidates.get(i)).append("\n");
      }
      var opts = OpenAiChatOptions.builder().temperature(0.0).maxTokens(256).build();
      var resp = resolved.chatModel().call(
          new Prompt(List.of(new SystemMessage(JUDGE_PROMPT), new UserMessage(sb.toString())), opts));
      String content = resp.getResult().getOutput().getText();
      int idx = parseBestIndex(content);
      return (idx >= 0 && idx < candidates.size()) ? idx : 0;
    } catch (Exception e) {
      log.warn("Max mode judge failed, defaulting to first candidate: {}", e.getMessage());
      return 0;
    }
  }

  private int parseBestIndex(String content) {
    try {
      String json = content;
      int brace = json.indexOf('{');
      int end = json.lastIndexOf('}');
      if (brace >= 0 && end > brace) json = json.substring(brace, end + 1);
      JsonNode node = mapper.readTree(json);
      return node.path("best").asInt(0);
    } catch (Exception e) {
      return 0;
    }
  }
}
