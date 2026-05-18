package io.codepilot.api.conversation;

import io.codepilot.core.deploy.ConversationRunDrainHook;
import org.springframework.stereotype.Component;

@Component
public class ConversationRunDrainHookImpl implements ConversationRunDrainHook {

  private final ConversationRunStore store;

  public ConversationRunDrainHookImpl(ConversationRunStore store) {
    this.store = store;
  }

  @Override
  public void onDrainStarted(String workerId) {
    store.markInterruptedByWorker(workerId);
  }
}
