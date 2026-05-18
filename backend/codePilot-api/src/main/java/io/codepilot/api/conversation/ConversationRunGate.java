package io.codepilot.api.conversation;

import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.run.ConversationRunProperties;
import org.springframework.stereotype.Component;

/** Decides whether a request uses the durable run queue. */
@Component
public class ConversationRunGate {

  private final ConversationRunStore store;
  private final ConversationRunProperties properties;

  public ConversationRunGate(ConversationRunStore store, ConversationRunProperties properties) {
    this.store = store;
    this.properties = properties;
  }

  public boolean useQueue(ConversationRunRequest req) {
    if (!store.isDbBacked()) return false;
    String mode = properties.getEnabled();
    if ("false".equalsIgnoreCase(mode)) return false;
    if ("true".equalsIgnoreCase(mode) || "auto".equalsIgnoreCase(mode)) {
      if (properties.isAgentOnly() && req.mode() != ConversationMode.AGENT) {
        return false;
      }
      boolean legacy = req.policy() != null && "legacy".equals(req.policy().engine());
      return !legacy;
    }
    return false;
  }
}
