package io.codepilot.common.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Result of a model connectivity test (POST /v1/models/test).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ModelTestResult(
    boolean ok,
    /** Latency of the test call in milliseconds. */
    long latencyMs,
    /** Sample output from the model (truncated). */
    String sampleOutput,
    /** Error message if ok=false. */
    String error) {

  public static ModelTestResult success(long latencyMs, String sampleOutput) {
    return new ModelTestResult(true, latencyMs, sampleOutput, null);
  }

  public static ModelTestResult failure(String error) {
    return new ModelTestResult(false, 0, null, error);
  }
}