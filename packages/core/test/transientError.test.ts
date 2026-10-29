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

  it("is the single source of truth: agent + stopVerify delegate to it", () => {
    expect(fromAgent).toBe(isTransientError);
    // stopVerify's judge classifier now agrees on the previously-divergent cases
    // (it used to miss network/timeout).
    expect(isTransientJudgeFailure("fetch failed")).toBe(true);
    expect(isTransientJudgeFailure("request timed out")).toBe(true);
    expect(isTransientJudgeFailure('tokens limit (访问限制)')).toBe(true);
  });
});
