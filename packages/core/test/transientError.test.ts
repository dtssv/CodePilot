import { describe, it, expect } from "vitest";
import {
  classifyProviderFailure,
  classifyFailover,
  shouldCascadeFailover,
  isTransientError,
} from "../src/transientError.js";
import { isTransientError as fromAgent } from "../src/agent.js";
import { isTransientJudgeFailure } from "../src/stopVerify.js";

describe("isTransientError (shared classifier)", () => {
  it("matches the network / errno / timeout / overload / rate-limit families", () => {
    for (const msg of [
      "fetch failed",
      "socket hang up",
      "ECONNRESET",
      "UND_ERR_SOCKET",
      "request timed out",
      "the operation timed out",
      "semaphore acquire aborted",
      "AbortError: The operation was aborted",
      "Anthropic 529: overloaded_error",
      "503 Service Unavailable",
      "OpenAI 429: rate limit exceeded",
      "too many requests",
      'tokens limit for minute (访问限制)',
      "stream ended unexpectedly",
    ]) {
      expect(isTransientError(msg), msg).toBe(true);
    }
  });

  it("does NOT match deterministic failures or deliberate stops", () => {
    for (const msg of [
      "OpenAI 401: invalid api key",
      "Model not found: gpt-nonexistent",
      "bad request: invalid schema",
      // The degeneration guard's deliberate stop must stay non-transient so it
      // surfaces instead of being silently retried.
      'output degenerated into a repeating loop ("la la "×99) — stopped',
    ]) {
      expect(isTransientError(msg), msg).toBe(false);
    }
  });

  it("vetoes 4xx client errors even when the body contains transient-looking noise", () => {
    // A 400's response body often carries a stray 5xx-range number or a
    // "please try again" nicety. The leading "<code>:" status must win so the
    // request fails fast instead of being retried with the same bad input.
    for (const msg of [
      "OpenAI 400: unsupported value 512 for parameter; please try again",
      "OpenAI 400: invalid request — timed out waiting for schema",
      "Anthropic 404: model not found (overloaded)",
      "Gemini 400: json schema error, try again later",
      "OpenAI 422: unprocessable entity 500",
    ]) {
      expect(isTransientError(msg), msg).toBe(false);
    }
  });

  it("does not veto the retryable 4xx (408/409/425/429) or any 5xx", () => {
    // These are exempt from the client-error veto, so a transient-looking body
    // is allowed to classify them as retryable (the HTTP layer's RETRYABLE_STATUS
    // in providers/retry.ts is the status-based source of truth; this text
    // classifier still needs transient wording to return true).
    for (const msg of [
      "OpenAI 408: request timeout",
      "OpenAI 409: conflict, please try again",
      "OpenAI 429: rate limit exceeded",
      "Anthropic 500: internal server error",
      "Gemini 503: service unavailable",
      "Anthropic 529: overloaded",
    ]) {
      expect(isTransientError(msg), msg).toBe(true);
    }
    // A retryable 4xx with no transient wording in the body is NOT vetoed, but
    // also has no transient signal, so the text classifier returns false. The
    // HTTP status layer still retries it.
    expect(isTransientError("OpenAI 425: too early")).toBe(false);
  });

  it("is the single source of truth: agent + stopVerify delegate to it", () => {
    expect(fromAgent).toBe(isTransientError);
    // stopVerify's judge classifier now agrees on the previously-divergent cases
    // (it used to miss network/timeout).
    expect(isTransientJudgeFailure("fetch failed")).toBe(true);
    expect(isTransientJudgeFailure("request timed out")).toBe(true);
    expect(isTransientJudgeFailure('tokens limit (访问限制)')).toBe(true);
  });
});

describe("classifyProviderFailure", () => {
  it("classifies a byte/size rejection as payload_too_large", () => {
    for (const msg of [
      "OpenAI 413: Payload Too Large",
      "413 Request Entity Too Large",
      "request too large for the gateway",
      "exceeds the maximum size allowed",
    ]) {
      expect(classifyProviderFailure(msg), msg).toBe("payload_too_large");
    }
  });

  it("classifies a token/context rejection as context_overflow", () => {
    for (const msg of [
      "This model's maximum context length is 128000 tokens",
      "prompt is too long",
      "context_length_exceeded",
      "please reduce the length of the messages",
    ]) {
      expect(classifyProviderFailure(msg), msg).toBe("context_overflow");
    }
  });

  it("treats an ambiguous 413 that mentions context/window as overflow, else payload", () => {
    expect(
      classifyProviderFailure("OpenAI 413: request exceeds the model's maximum context length"),
    ).toBe("context_overflow");
    expect(classifyProviderFailure("OpenAI 413: payload too large")).toBe("payload_too_large");
  });

  it("falls back to transient / fatal for everything else", () => {
    expect(classifyProviderFailure("fetch failed")).toBe("transient");
    expect(classifyProviderFailure("Anthropic 529: overloaded_error")).toBe("transient");
    expect(classifyProviderFailure("OpenAI 401: invalid api key")).toBe("fatal");
    expect(classifyProviderFailure("Model not found: gpt-nonexistent")).toBe("fatal");
  });
});

describe("classifyFailover", () => {
  it("maps framed HTTP status codes to a failover class", () => {
    expect(classifyFailover("OpenAI 401: invalid api key")).toBe("auth");
    expect(classifyFailover("OpenAI 403: forbidden")).toBe("auth");
    expect(classifyFailover("OpenAI 400: bad request")).toBe("invalid_request");
    expect(classifyFailover("OpenAI 404: model not found")).toBe("invalid_request");
    expect(classifyFailover("OpenAI 429: Too Many Requests")).toBe("rate_limit");
    expect(classifyFailover("Anthropic 529: overloaded_error")).toBe("overloaded");
    expect(classifyFailover("Anthropic 503: service unavailable")).toBe("server_5xx");
    // Retryable 4xx behave like transient pressure.
    expect(classifyFailover("OpenAI 408: request timeout")).toBe("rate_limit");
  });

  it("splits a 429 into quota vs rate_limit by body phrasing", () => {
    expect(classifyFailover("OpenAI 429: insufficient_quota, you exceeded your current quota")).toBe("quota");
    expect(classifyFailover("OpenAI 429: rate limit reached, slow down")).toBe("rate_limit");
  });

  it("classifies status-less messages by phrasing", () => {
    expect(classifyFailover("quota exhausted")).toBe("quota");
    expect(classifyFailover("rate limit exceeded")).toBe("rate_limit");
    expect(classifyFailover("upstream is overloaded, try again")).toBe("overloaded");
    expect(classifyFailover("ETIMEDOUT")).toBe("transport");
    expect(classifyFailover("fetch failed")).toBe("transport");
    expect(classifyFailover("invalid api key")).toBe("auth");
    expect(classifyFailover("totally unrecognised message")).toBe("other");
  });
});

describe("shouldCascadeFailover", () => {
  it("cascades only transient pressure by default", () => {
    expect(shouldCascadeFailover("rate_limit")).toBe(true);
    expect(shouldCascadeFailover("overloaded")).toBe(true);
    expect(shouldCascadeFailover("server_5xx")).toBe(true);
    expect(shouldCascadeFailover("transport")).toBe(true);
    expect(shouldCascadeFailover("auth")).toBe(false);
    expect(shouldCascadeFailover("invalid_request")).toBe(false);
    expect(shouldCascadeFailover("other")).toBe(false);
  });

  it("gates quota on the policy", () => {
    expect(shouldCascadeFailover("quota")).toBe(false); // default "fail"
    expect(shouldCascadeFailover("quota", "fail")).toBe(false);
    expect(shouldCascadeFailover("quota", "next")).toBe(true);
  });
});
