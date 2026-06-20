package io.codepilot.common.api;

/** Canonical, documented error codes used across modules and shipped to the client. */
public final class ErrorCodes {
  // 4xx
  public static final int BAD_REQUEST = 40001;
  public static final int UNAUTHORIZED = 40101;
  public static final int FORBIDDEN = 40301;
  public static final int NOT_FOUND = 40401;
  public static final int RATE_LIMITED = 42901;

  /** Durable agent queue / admission full — client should backoff and retry. */
  public static final int QUEUE_FULL = 42902;

  public static final int SECURITY_BLOCKED = 45001;
  public static final int SYSTEM_PROMPT_LEAK = 45002;
  public static final int USER_SKILL_INVALID = 45003;

  // 5xx
  public static final int INTERNAL = 50001;
  public static final int UPSTREAM_MODEL = 50002;

  private ErrorCodes() {}
}
