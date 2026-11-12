// fetchWithRetry: status-based retry with the x-should-retry override.
// The explicit directive wins over the status heuristic in both directions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, shouldRetryHeader } from "../src/providers/retry.js";

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "body", { status, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldRetryHeader", () => {
  it("parses true/false and ignores everything else", () => {
    expect(shouldRetryHeader(res(200, { "x-should-retry": "true" }))).toBe(true);
    expect(shouldRetryHeader(res(200, { "x-should-retry": "false" }))).toBe(false);
    expect(shouldRetryHeader(res(200, { "x-should-retry": "maybe" }))).toBeNull();
    expect(shouldRetryHeader(res(200, {}))).toBeNull();
  });
});

describe("fetchWithRetry — x-should-retry", () => {
  it("does not retry a 503 that carries x-should-retry: false", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValue(res(503, { "x-should-retry": "false" }) as never);
    const onRetry = vi.fn();
    const out = await fetchWithRetry("http://x", {}, { maxRetries: 3, baseDelayMs: 1, onRetry });
    expect(out.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a normally non-retryable status when x-should-retry: true", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch" as never).mockImplementation((async () => {
      call++;
      // 400 is not in the retryable set, but the directive forces a retry;
      // the second response succeeds.
      return call === 1 ? res(400, { "x-should-retry": "true" }) : res(200);
    }) as never);
    const out = await fetchWithRetry("http://x", {}, { maxRetries: 3, baseDelayMs: 1 });
    expect(out.status).toBe(200);
    expect(call).toBe(2);
  });

  it("retries a 429 by status when no directive is present, then returns ok", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch" as never).mockImplementation((async () => {
      call++;
      return call === 1 ? res(429) : res(200);
    }) as never);
    const out = await fetchWithRetry("http://x", {}, { maxRetries: 3, baseDelayMs: 1 });
    expect(out.status).toBe(200);
    expect(call).toBe(2);
  });

  it("stops at a deterministic 400 with no directive (no retry)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValue(res(400) as never);
    const out = await fetchWithRetry("http://x", {}, { maxRetries: 3, baseDelayMs: 1 });
    expect(out.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
