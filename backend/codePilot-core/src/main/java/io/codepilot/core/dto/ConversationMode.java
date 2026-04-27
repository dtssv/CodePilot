package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Conversation mode: chat (read-only) vs. agent (Plan-First). */
public enum ConversationMode {
  @JsonProperty("chat")
  CHAT,
  @JsonProperty("agent")
  AGENT
}