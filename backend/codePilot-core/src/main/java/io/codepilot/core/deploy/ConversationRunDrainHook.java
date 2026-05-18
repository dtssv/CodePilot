package io.codepilot.core.deploy;

/** Optional hook for P2b durable runs during deploy drain. */
public interface ConversationRunDrainHook {

  void onDrainStarted(String workerId);
}
