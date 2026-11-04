import { describe, it, expect } from "vitest";
import { isTransientError } from "../src/transientError.js";
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
