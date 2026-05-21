package io.codepilot.core.run;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Admission limits for durable agent runs (back-pressure before DB queue grows without bound). */
@ConfigurationProperties(prefix = "codepilot.conversation.admission")
public class ConversationRunAdmissionProperties {

  /** Master switch; when false, only per-worker concurrency applies. */
  private boolean enabled = true;

  /** Max queued runs cluster-wide (Redis counter). */
  private int maxGlobalQueued = 5_000;

  /** Max runs in {@code running} state cluster-wide. */
  private int maxGlobalRunning = 800;

  /** Max queued runs per user. */
  private int maxUserQueued = 8;

  /** Max concurrent running agent runs per user. */
  private int maxUserRunning = 2;

  /** Default Retry-After (seconds) when admission rejects. */
  private int retryAfterSeconds = 30;

  /** Max concurrent graph executions per backend pod. */
  private int maxWorkerConcurrent = 32;

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public int getMaxGlobalQueued() {
    return maxGlobalQueued;
  }

  public void setMaxGlobalQueued(int maxGlobalQueued) {
    this.maxGlobalQueued = maxGlobalQueued;
  }

  public int getMaxGlobalRunning() {
    return maxGlobalRunning;
  }

  public void setMaxGlobalRunning(int maxGlobalRunning) {
    this.maxGlobalRunning = maxGlobalRunning;
  }

  public int getMaxUserQueued() {
    return maxUserQueued;
  }

  public void setMaxUserQueued(int maxUserQueued) {
    this.maxUserQueued = maxUserQueued;
  }

  public int getMaxUserRunning() {
    return maxUserRunning;
  }

  public void setMaxUserRunning(int maxUserRunning) {
    this.maxUserRunning = maxUserRunning;
  }

  public int getRetryAfterSeconds() {
    return retryAfterSeconds;
  }

  public void setRetryAfterSeconds(int retryAfterSeconds) {
    this.retryAfterSeconds = retryAfterSeconds;
  }

  public int getMaxWorkerConcurrent() {
    return maxWorkerConcurrent;
  }

  public void setMaxWorkerConcurrent(int maxWorkerConcurrent) {
    this.maxWorkerConcurrent = maxWorkerConcurrent;
  }
}
