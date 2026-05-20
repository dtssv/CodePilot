package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.SocketTimeoutException;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;

class GraphFailurePolicyTest {

  @Test
  void retryableTimeouts() {
    assertTrue(GraphFailurePolicy.isRetryable(new TimeoutException("read timed out")));
    assertTrue(GraphFailurePolicy.isRetryable(new SocketTimeoutException("connect timed out")));
  }

  @Test
  void nonRetryableProgrammingErrors() {
    assertTrue(GraphFailurePolicy.isNonRetryable(new NullPointerException("x")));
    assertFalse(GraphFailurePolicy.isRetryable(new NullPointerException("x")));
  }

  @Test
  void maxRetriesConstant() {
    org.junit.jupiter.api.Assertions.assertEquals(3, GraphFailurePolicy.MAX_LLM_RETRIES);
  }
}
