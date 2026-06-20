package io.codepilot.core.session.prompt;

import io.codepilot.core.session.SessionState;

/** Context passed to each {@link PromptLayer} during prompt building. */
public record PromptContext(SessionState session, String modelId, String modelName) {}
