import { describe, expect, it } from "vitest";
import { DoomLoopDetector } from "../src/doomLoop.js";

// Loop-detection thresholds and the per-tool exclusion list are configurable.
// Defaults equal the built-in constants, so an empty/absent config is a no-op;
// these tests pin the overrides and the exclusion behaviour that reduce false
// positives on legitimate retries / idempotent polling.
describe("DoomLoopDetector — configurable thresholds", () => {
  it("defaults to the built-in warn (3) / refuse (4) thresholds", () => {
    const d = new DoomLoopDetector();
    const inp = { command: "ls" };
    expect(d.check("bash", inp).warn).toBe(false); // 1
    expect(d.check("bash", inp).warn).toBe(false); // 2
    expect(d.check("bash", inp).warn).toBe(true); // 3 → warn
    expect(d.check("bash", inp).refuse).toBe(true); // 4 → refuse
  });

  it("honours a raised refuseAt so earlier repeats still execute", () => {
    const d = new DoomLoopDetector(undefined, { refuseAt: 10, warnAt: 8 });
    const inp = { command: "git status" };
    // The 4th identical call is no longer refused under the raised threshold.
    for (let i = 0; i < 4; i++) {
      const r = d.check("bash", inp);
      expect(r.refuse).toBe(false);
    }
    // It still refuses once the raised threshold is reached.
    let refused = false;
    for (let i = 0; i < 8; i++) {
      if (d.check("bash", inp).refuse) refused = true;
    }
    expect(refused).toBe(true);
  });

  it("treats refuseAt:0 as never-refuse for the exact-repetition layer (warn only)", () => {
    // Raise the rotating-batch thresholds out of the way so this isolates the
    // layer-1 (exact repetition) refuse gate, which refuseAt:0 disables.
    const d = new DoomLoopDetector(undefined, { refuseAt: 0, seqWindow: 1000, seqRepeat: 1000 });
    const inp = { command: "curl http://localhost/health" };
    let refused = false;
    let warned = false;
    for (let i = 0; i < 50; i++) {
      const r = d.check("bash", inp);
      if (r.refuse) refused = true;
      if (r.warn) warned = true;
    }
    expect(refused).toBe(false);
    expect(warned).toBe(true);
  });

  it("honours a custom rotating-batch window / repeat count", () => {
    // Window 2, repeat 2: a tight rotating pair trips immediately.
    const d = new DoomLoopDetector(undefined, { seqWindow: 2, seqRepeat: 2, refuseAt: 1000 });
    const a = { command: "a" };
    const b = { command: "b" };
    d.check("bash", a);
    d.check("bash", b);
    d.check("bash", a);
    const r = d.check("bash", b);
    expect(r.refuse).toBe(true);
    expect(r.kind).toBe("seq");
  });

  it("seqRefuse:false downgrades a rotating-batch loop to warn-only", () => {
    // Same tight rotating pair, but layer 2 is set to warn instead of refuse —
    // the counterpart of refuseAt:0 for the exact-repetition layer.
    const d = new DoomLoopDetector(undefined, {
      seqWindow: 2,
      seqRepeat: 2,
      seqRefuse: false,
      refuseAt: 1000,
    });
    const a = { command: "a" };
    const b = { command: "b" };
    d.check("bash", a);
    d.check("bash", b);
    d.check("bash", a);
    const r = d.check("bash", b);
    expect(r.refuse).toBe(false);
    expect(r.warn).toBe(true);
    expect(r.kind).toBe("seq");
    expect(r.message).toContain("repeating a batch");
  });
});

describe("DoomLoopDetector — exclude", () => {
  it("never counts an excluded tool name toward warn/refuse", () => {
    const d = new DoomLoopDetector(undefined, { exclude: ["bash"] });
    const inp = { command: "tail -f log" };
    for (let i = 0; i < 20; i++) {
      const r = d.check("bash", inp);
      expect(r.refuse).toBe(false);
      expect(r.warn).toBe(false);
      expect(r.kind).toBeUndefined();
    }
  });

  it("still refuses a non-excluded tool while excluding another", () => {
    const d = new DoomLoopDetector(undefined, { exclude: ["bash"] });
    const bash = { command: "poll" };
    const edit = { path: "f.ts", search: "x", replace: "y" };
    for (let i = 0; i < 10; i++) d.check("bash", bash); // excluded, never trips
    let refused = false;
    for (let i = 0; i < 6; i++) if (d.check("edit_file", edit).refuse) refused = true;
    expect(refused).toBe(true);
  });

  it("matches a tool::glob signature pattern", () => {
    // Exclude only read_file calls on paths under logs/.
    const d = new DoomLoopDetector(undefined, { exclude: ["read_file::*logs/*"] });
    const logs = { path: "logs/app.log", startLine: 0 };
    const src = { path: "src/main.ts", startLine: 0 };
    for (let i = 0; i < 20; i++) {
      expect(d.check("read_file", logs).refuse).toBe(false);
    }
    // A different path is still counted (exact-repetition still applies).
    let refused = false;
    for (let i = 0; i < 6; i++) if (d.check("read_file", src).refuse) refused = true;
    expect(refused).toBe(true);
  });

  it("does not exclude a tool whose name only partially matches a bare pattern", () => {
    const d = new DoomLoopDetector(undefined, { exclude: ["bash"] });
    // "bash_jobs" is a different tool — the bare pattern is anchored.
    const inp = { foo: "bar" };
    let refused = false;
    for (let i = 0; i < 6; i++) if (d.check("bash_jobs", inp).refuse) refused = true;
    expect(refused).toBe(true);
  });
});

describe("DoomLoopDetector — telemetry kind", () => {
  it("labels each firing layer", () => {
    const warn = new DoomLoopDetector();
    const inp = { command: "x" };
    warn.check("bash", inp);
    warn.check("bash", inp);
    expect(warn.check("bash", inp).kind).toBe("warn");
    expect(warn.check("bash", inp).kind).toBe("refuse");
  });

  it("flags a redundant re-ask", () => {
    const d = new DoomLoopDetector();
    const ask = { questions: [{ question: "Which database should I use?" }] };
    d.markQuestionsAnswered(ask);
    const r = d.check("ask_user_question", { questions: [{ question: "Which database should I use?" }] });
    expect(r.refuse).toBe(true);
    expect(r.kind).toBe("ask_reask");
  });
});
