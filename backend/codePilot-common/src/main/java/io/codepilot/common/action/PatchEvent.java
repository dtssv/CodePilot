package io.codepilot.common.action;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Represents a code patch produced by an action (refactor/comment/gentest/gendoc).
 *
 * <p>The patch follows a unified diff-like structure that the plugin can apply
 * via its DiffApplier component.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PatchEvent(
    /** File path to apply the patch to. */
    String path,
    /** Type of patch operation. */
    Type type,
    /** The search string to find in the original content. */
    String search,
    /** The replacement string. */
    String replace,
    /** Line range for the patch (optional, for context). */
    ActionRequest.Context.Range range,
    /** Human-readable description of what this patch does. */
    String description) {

  /** Patch operation types. */
  public enum Type {
    /** Replace existing content (search → replace). */
    REPLACE,
    /** Insert new content at a specific position. */
    INSERT,
    /** Delete existing content. */
    DELETE,
    /** Create a new file with the given content. */
    CREATE
  }
}