package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";
    long startTime = System.currentTimeMillis();

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor,
      MetricsHelper metrics) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  var patches = tryParsePatches(fullResponse.toString(), req.context().path());
                  if (!patches.isEmpty()) {
                    sink.tryEmitNext(new AgentEvent.PatchEvent(patches));
                  }

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<AgentEvent.PatchEvent.Patch> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new AgentEvent.PatchEvent.Patch(
            filePath,
            "replace",
            null,
            null,
            null,
            response,
            "Action output"));
  }
}package io.codepilot.core.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.action.PatchEvent;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptRegistry;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Service for one-shot actions (refactor, review, comment, gentest, gendoc).
 *
 * <p>Each action is a shortcut wrapper around the conversation service:
 * <ol>
 *   <li>Load the action-specific system prompt from {@link PromptRegistry}.</li>
 *   <li>Build a single-shot prompt with the code context + instruction.</li>
 *   <li>Call the model (streaming for delta events).</li>
 *   <li>Emit SSE events: delta* → patch? → usage → done.</li>
 * </ol>
 *
 * <p>Actions are always single-turn — no tool calls, no plan, no multi-round loop.
 */
@Service
public class ActionService {

  private static final Logger LOG = LoggerFactory.getLogger(ActionService.class);

  /** Maps action type to the prompt registry key. */
  private static final Map<ActionType, String> PROMPT_KEYS = Map.of(
      ActionType.REFACTOR, "action.refactor.system",
      ActionType.REVIEW,   "action.review.system",
      ActionType.COMMENT,  "action.comment.system",
      ActionType.GENTEST,  "action.gentest.system",
      ActionType.GENDOC,   "action.gendoc.system");

  private final ModelService modelService;
  private final PromptRegistry promptRegistry;
  private final SafeguardAdvisor safeguardAdvisor;

  public ActionService(
      ModelService modelService,
      PromptRegistry promptRegistry,
      SafeguardAdvisor safeguardAdvisor) {
    this.modelService = modelService;
    this.promptRegistry = promptRegistry;
    this.safeguardAdvisor = safeguardAdvisor;
  }

  /** Action type enum. */
  public enum ActionType {
    REFACTOR, REVIEW, COMMENT, GENTEST, GENDOC
  }

  /**
   * Executes an action and returns a Flux of SSE events.
   *
   * <p>Event sequence: delta* → patch? → usage → done.
   */
  public Flux<AgentEvent> execute(ActionType type, ActionRequest req) {
    String sessionId = req.sessionId() != null ? req.sessionId() : UUID.randomUUID().toString();
    String modelId = req.modelId() != null ? req.modelId() : "codePilot-default";

    return modelService.resolveChatClient(modelId, "system")
        .flatMapMany(chatClient -> Flux.create(sink -> {
          try {
            // 1. Load action-specific system prompt
            String promptKey = PROMPT_KEYS.get(type);
            String systemText = promptRegistry.system(promptKey);

            // 2. Build context-aware system prompt
            String language = req.context().language() != null ? req.context().language() : "unknown";
            systemText = systemText
                .replace("{{language}}", language)
                .replace("{{filePath}}", req.context().path());

            // 3. Build user message
            String userText = buildUserMessage(type, req);

            // 4. Assemble and sanitize prompt
            Prompt prompt = new Prompt(
                java.util.List.of(
                    new SystemMessage(systemText),
                    new UserMessage(userText)));
            prompt = safeguardAdvisor.sanitize(prompt);

            // 5. Stream the model response
            StringBuilder fullResponse = new StringBuilder();

            chatClient
                .prompt(prompt)
                .stream()
                .content()
                .doOnNext(text -> {
                  if (text != null && !text.isEmpty()) {
                    fullResponse.append(text);
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                  }
                })
                .doOnComplete(() -> {
                  // Try to parse the full response as patches
                  tryParsePatches(fullResponse.toString(), req.context().path())
                      .forEach(patch -> sink.tryEmitNext(
                          new AgentEvent.PatchEvent(patch)));

                  sink.tryEmitNext(new DoneEvent("final", UUID.randomUUID().toString(), null, null));
                  sink.tryEmitComplete();
                })
                .doOnError(err -> {
                  LOG.error("Action {} failed: {}", type, err.getMessage());
                  sink.tryEmitNext(new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                  sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                  sink.tryEmitComplete();
                })
                .subscribe();

          } catch (Exception e) {
            LOG.error("Action {} error: {}", type, e.getMessage());
            sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
            sink.tryEmitNext(new DoneEvent("failed", null, null, null));
            sink.tryEmitComplete();
          }
        }));
  }

  /** Builds the user message based on action type and request. */
  private String buildUserMessage(ActionType type, ActionRequest req) {
    var sb = new StringBuilder();
    sb.append("File: ").append(req.context().path()).append('\n');

    if (req.context().range() != null) {
      sb.append("Lines: ").append(req.context().range().start())
          .append("-").append(req.context().range().end()).append('\n');
    }

    sb.append("\n```").append(req.context().language() != null ? req.context().language() : "")
        .append('\n');
    sb.append(req.context().content());
    sb.append("\n```\n");

    switch (type) {
      case REFACTOR -> {
        sb.append("\nInstruction: ").append(req.instruction()).append('\n');
        sb.append("\nPlease refactor the code according to the instruction. ");
        sb.append("Output the refactored code and any patch operations.");
      }
      case REVIEW -> {
        sb.append("\nPlease review this code for bugs, style issues, performance problems, ");
        sb.append("and security vulnerabilities. Provide a structured review report.");
      }
      case COMMENT -> {
        sb.append("\nPlease add appropriate documentation comments to this code. ");
        sb.append("Output the commented version as a patch.");
      }
      case GENTEST -> {
        sb.append("\nPlease generate unit tests for this code.");
        if (req.hints() != null && req.hints().containsKey("testFramework")) {
          sb.append(" Use ").append(req.hints().get("testFramework")).append(" framework.");
        }
      }
      case GENDOC -> {
        sb.append("\nPlease generate documentation for this code.");
        if (req.hints() != null && req.hints().containsKey("docTarget")) {
          sb.append(" Target: ").append(req.hints().get("docTarget")).append('.');
        }
      }
    }

    return sb.toString();
  }

  /** Attempts to parse the model response into PatchEvent objects. */
  private java.util.List<PatchEvent> tryParsePatches(String response, String filePath) {
    // For M5, we emit the full response as a single REPLACE patch.
    // In production, the model would output structured patch JSON that we parse.
    if (response == null || response.isBlank()) {
      return java.util.List.of();
    }
    return java.util.List.of(
        new PatchEvent(
            filePath,
            PatchEvent.Type.REPLACE,
            null, // search — full content replacement
            response,
            null,
            "Action output"));
  }
}