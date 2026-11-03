import { describe, expect, it } from "vitest";
import {
  applyContextTransform,
  validateTransformedView,
} from "../src/contextTransform.js";
import type { ProviderMessage } from "../src/providers/types.js";

const baseView: ProviderMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", toolCallId: "t1", content: "ok" }],
  },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

describe("validateTransformedView", () => {
  it("accepts a well-formed, pruned view with paired tool calls", () => {
    expect(validateTransformedView(baseView).ok).toBe(true);
  });

  it("rejects an empty or non-array view", () => {
    expect(validateTransformedView([]).ok).toBe(false);
    expect(validateTransformedView(null).ok).toBe(false);
    expect(validateTransformedView("nope").ok).toBe(false);
  });

  it("rejects an illegal role", () => {
    const bad = [{ role: "robot", content: [{ type: "text", text: "x" }] }];
    const r = validateTransformedView(bad);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/role/);
  });

  it("rejects a dropped tool_result for a kept tool_use", () => {
    const bad: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
    ];
    const r = validateTransformedView(bad);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tool_use t1/);
  });

  it("rejects an orphan tool_result answering no tool_use", () => {
    const bad: ProviderMessage[] = [
      { role: "user", content: [{ type: "tool_result", toolCallId: "ghost", content: "x" }] },
    ];
    const r = validateTransformedView(bad);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tool_result ghost/);
  });
});

describe("applyContextTransform", () => {
  it("returns the original view when no transform is set", () => {
    expect(applyContextTransform(baseView, undefined)).toBe(baseView);
  });

  it("applies a valid transform and returns the new view", () => {
    const out = applyContextTransform(baseView, (v) =>
      v.filter((m) => m.content.every((c) => c.type !== "tool_use" && c.type !== "tool_result")),
    );
    // The paired tool_use/tool_result were dropped together → still valid.
    expect(out).not.toBe(baseView);
    expect(out.length).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/tool_use|tool_result/);
  });

  it("does not mutate the caller's view even if the transform edits in place", () => {
    const transform = (v: ProviderMessage[]): ProviderMessage[] => {
      v[0]!.content = [{ type: "text", text: "MUTATED" }];
      return v;
    };
    const out = applyContextTransform(baseView, transform);
    // The returned (copied) view reflects the edit...
    expect(JSON.stringify(out[0])).toMatch(/MUTATED/);
    // ...but the original is untouched.
    expect(JSON.stringify(baseView[0])).toMatch(/hello/);
  });

  it("falls back to the original view when the transform throws", () => {
    const reasons: string[] = [];
    const out = applyContextTransform(
      baseView,
      () => {
        throw new Error("boom");
      },
      (r) => reasons.push(r),
    );
    expect(out).toBe(baseView);
    expect(reasons[0]).toMatch(/threw.*boom/);
  });

  it("falls back when the transform breaks tool pairing (fail-soft)", () => {
    const reasons: string[] = [];
    const out = applyContextTransform(
      baseView,
      // Drop ONLY the tool_result, leaving an unpaired tool_use.
      (v) => v.filter((m) => !m.content.some((c) => c.type === "tool_result")),
      (r) => reasons.push(r),
    );
    expect(out).toBe(baseView);
    expect(reasons[0]).toMatch(/invalid view/);
  });
});
