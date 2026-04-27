package io.codepilot.common.action;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;

/**
 * Unified request body for all action endpoints (refactor/review/comment/gentest/gendoc).
 *
 * <p>Actions are shortcut wrappers around the conversation service, triggered by
 * right-click menu or keyboard shortcut in the IDE.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ActionRequest(
    /** Session ID — may be a new UUID for standalone actions, or an existing session. */
    String sessionId,
    /** Model to use. */
    String modelId,
    /** The code context to act upon. */
    @NotBlank Context context,
    /** Natural language instruction (required for refactor; optional for others). */
    String instruction,
    /** Additional hints for specific actions. */
    Map<String, Object> hints) {

  /** Code context item for an action request. */
  public record Context(
      /** File path relative to workspace root. */
      @NotBlank String path,
      /** Selected code content. */
      String content,
      /** Language identifier (e.g. "java", "python"). */
      String language,
      /** Line range of the selection: {start, end}. */
      Range range) {}

  /** A line range. */
  public record Range(int start, int end) {}
}