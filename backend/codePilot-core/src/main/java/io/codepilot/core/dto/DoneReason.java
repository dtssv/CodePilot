package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Why a turn ended; mirrors {@code done.reason} on the SSE wire. */
public enum DoneReason {
  @JsonProperty("final")
  FINAL,
  @JsonProperty("subtask_done")
  SUBTASK_DONE,
  @JsonProperty("awaiting_user_input")
  AWAITING_USER_INPUT,
  @JsonProperty("paused")
  PAUSED,
  @JsonProperty("max_steps")
  MAX_STEPS,
  @JsonProperty("stopped")
  STOPPED,
  @JsonProperty("failed")
  FAILED
}