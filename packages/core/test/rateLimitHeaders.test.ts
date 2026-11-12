// Provider rate-limit header parsing. The parser normalizes the common header
// families into a camelCase snapshot the session surfaces into the status line.

import { describe, expect, it } from "vitest";
import { parseRateLimitHeaders } from "../src/providers/retry.js";

function res(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

describe("parseRateLimitHeaders", () => {
  it("returns null when no rate-limit headers are present", () => {
    expect(parseRateLimitHeaders(res({ "content-type": "application/json" }))).toBeNull();
  });

  it("parses the anthropic-ratelimit-* family", () => {
    const r = parseRateLimitHeaders(
      res({
        "anthropic-ratelimit-requests-remaining": "48",
        "anthropic-ratelimit-tokens-remaining": "120000",
      }),
    );
    expect(r).toEqual({ requestsRemaining: 48, tokensRemaining: 120000 });
  });

  it("parses the x-ratelimit-* family", () => {
    const r = parseRateLimitHeaders(
      res({
        "x-ratelimit-remaining-requests": "7",
        "x-ratelimit-remaining-tokens": "900",
      }),
    );
    expect(r).toEqual({ requestsRemaining: 7, tokensRemaining: 900 });
  });

  it("derives resetsInSeconds from retry-after (seconds)", () => {
    const r = parseRateLimitHeaders(res({ "retry-after": "30" }));
    expect(r).toEqual({ resetsInSeconds: 30 });
  });

  it("ignores non-numeric header values", () => {
    expect(parseRateLimitHeaders(res({ "x-ratelimit-remaining-requests": "n/a" }))).toBeNull();
  });
});
