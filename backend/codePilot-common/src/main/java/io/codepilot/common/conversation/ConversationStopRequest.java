package io.codepilot.common.conversation;

import jakarta.validation.constraints.NotBlank;

/** Request for {@code POST /v1/conversation/stop}. */
public record ConversationStopRequest(@NotBlank String sessionId) {}