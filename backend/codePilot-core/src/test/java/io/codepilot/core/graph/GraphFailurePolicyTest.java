package io.codepilot.core.graph;

import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.net.SocketTimeoutException;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

  @Test
  void clientErrorDetection() {
    // 400 Bad Request is a client error
    WebClientResponseException badRequest =
        WebClientResponseException.create(400, "Bad Request", null, "invalid parameter".getBytes(), null);
    assertTrue(GraphFailurePolicy.isClientError(badRequest));

    // 404 Not Found is a client error
    WebClientResponseException notFound =
        WebClientResponseException.create(404, "Not Found", null, "model not found".getBytes(), null);
    assertTrue(GraphFailurePolicy.isClientError(notFound));

    // 429 is NOT a client error (it's retryable)
    WebClientResponseException tooManyRequests =
        WebClientResponseException.create(429, "Too Many Requests", null, "rate limited".getBytes(), null);
    assertFalse(GraphFailurePolicy.isClientError(tooManyRequests));

    // 500 is NOT a client error
    WebClientResponseException serverError =
        WebClientResponseException.create(500, "Internal Server Error", null, "server error".getBytes(), null);
    assertFalse(GraphFailurePolicy.isClientError(serverError));
  }

  @Test
  void transientBadRequestIsRetryable() {
    // 400 with transient indicators should be retryable
    WebClientResponseException rateLimit400 =
        WebClientResponseException.create(400, "Bad Request", null,
            "{\"error\": \"rate limit exceeded\"}".getBytes(), null);
    assertTrue(GraphFailurePolicy.isTransientBadRequest(rateLimit400));

    WebClientResponseException overloaded400 =
        WebClientResponseException.create(400, "Bad Request", null,
            "{\"error\": \"service is busy, please retry\"}".getBytes(), null);
    assertTrue(GraphFailurePolicy.isTransientBadRequest(overloaded400));

    // 400 without transient indicators should NOT be retryable
    WebClientResponseException paramError400 =
        WebClientResponseException.create(400, "Bad Request", null,
            "{\"error\": \"invalid parameter: reasoning_effort not supported\"}".getBytes(), null);
    assertFalse(GraphFailurePolicy.isTransientBadRequest(paramError400));
    assertFalse(GraphFailurePolicy.isRetryable(paramError400));
  }

  @Test
  void nonTransient400NotRetryable() {
    WebClientResponseException paramError =
        WebClientResponseException.create(400, "Bad Request", null,
            "{\"error\": \"invalid parameter\"}".getBytes(), null);
    assertFalse(GraphFailurePolicy.isRetryable(paramError));
  }
}
