// Status line: payload builder, declarative preset renderer, and the command
// runner. The preset path lets users get a useful status bar with no scripting;
// the command path spawns a script and renders its stdout.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPayload,
  renderPresetStatusLine,
  resolvePresetItems,
  runStatusLine,
  STATUS_LINE_PRESETS,
  type StatusLinePresetConfig,
  type StatusLineCommandConfig,
} from "../src/statusLine.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function samplePayload(over: Partial<Parameters<typeof buildPayload>[0]> = {}) {
  return buildPayload({
    sessionId: "sess_12345678abcd",
    renderWidth: 120,
    cwd: "/work/project",
    model: "a-model",
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    contextWindowSize: 10000,
    usedPercentage: 12,
    version: "1.0.0",
    ...over,
  });
}

describe("buildPayload", () => {
  it("maps flat input into the nested payload and computes remaining %", () => {
    const p = samplePayload();
    expect(p.context_window.used_percentage).toBe(12);
    expect(p.context_window.remaining_percentage).toBe(88);
    expect(p.model.id).toBe("a-model");
    expect(p.workspace.current_dir).toBe("/work/project");
  });

  it("omits git_branch and rate_limit when not supplied", () => {
    const p = samplePayload();
    expect(p.workspace.git_branch).toBeUndefined();
    expect(p.rate_limit).toBeUndefined();
  });

  it("includes git_branch when supplied", () => {
    const p = samplePayload({ gitBranch: "main" });
    expect(p.workspace.git_branch).toBe("main");
  });

  it("maps the camelCase rate-limit snapshot to the snake_case payload field", () => {
    const p = samplePayload({
      rateLimit: { requestsRemaining: 42, tokensRemaining: 9000, resetsInSeconds: 30 },
    });
    expect(p.rate_limit).toEqual({
      requests_remaining: 42,
      tokens_remaining: 9000,
      resets_in_seconds: 30,
    });
  });

  it("drops an empty rate-limit snapshot", () => {
    const p = samplePayload({ rateLimit: {} });
    expect(p.rate_limit).toBeUndefined();
  });
});

describe("resolvePresetItems", () => {
  it("returns the named preset's items", () => {
    expect(resolvePresetItems({ type: "preset", preset: "minimal" })).toEqual(
      STATUS_LINE_PRESETS.minimal,
    );
  });

  it("defaults to the 'default' preset when unnamed", () => {
    expect(resolvePresetItems({ type: "preset" })).toEqual(STATUS_LINE_PRESETS.default);
  });

  it("explicit items override the named preset", () => {
    const cfg: StatusLinePresetConfig = { type: "preset", preset: "verbose", items: ["model", "context"] };
    expect(resolvePresetItems(cfg)).toEqual(["model", "context"]);
  });

  it("falls back to default on an unknown preset name", () => {
    const cfg = { type: "preset", preset: "nope" } as unknown as StatusLinePresetConfig;
    expect(resolvePresetItems(cfg)).toEqual(STATUS_LINE_PRESETS.default);
  });
});

describe("renderPresetStatusLine", () => {
  it("renders model · context for the minimal preset", () => {
    const line = renderPresetStatusLine({ type: "preset", preset: "minimal" }, samplePayload());
    expect(line).toBe("a-model · ctx 12%");
  });

  it("includes the git branch when the payload has one", () => {
    const line = renderPresetStatusLine(
      { type: "preset", preset: "default" },
      samplePayload({ gitBranch: "feature/x" }),
    );
    expect(line).toContain("⎇ feature/x");
  });

  it("omits items with no data (no branch, no rate)", () => {
    const line = renderPresetStatusLine({ type: "preset", preset: "default" }, samplePayload());
    // default = model, mode, context, branch — no mode (no param_summary), no branch.
    expect(line).toBe("a-model · ctx 12%");
  });

  it("renders a rate-limit summary when present", () => {
    const line = renderPresetStatusLine(
      { type: "preset", items: ["rate"] },
      samplePayload({ rateLimit: { requestsRemaining: 5, resetsInSeconds: 12 } }),
    );
    expect(line).toBe("5 req 12s");
  });

  it("renders basename for cwd and a short session id", () => {
    const line = renderPresetStatusLine(
      { type: "preset", items: ["cwd", "session"] },
      samplePayload(),
    );
    expect(line).toBe("project · sess_123");
  });
});

describe("runStatusLine (command)", () => {
  it("runs a script and returns its stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "statusline-"));
    dirs.push(dir);
    const script = join(dir, "sl.sh");
    writeFileSync(script, "#!/bin/sh\ncat > /dev/null\nprintf 'custom bar'\n", "utf-8");
    chmodSync(script, 0o755);
    const cfg: StatusLineCommandConfig = { type: "command", command: script };
    const r = await runStatusLine(cfg, samplePayload(), { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("custom bar");
  });

  it("reports failure for a non-zero exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "statusline-"));
    dirs.push(dir);
    const script = join(dir, "fail.sh");
    writeFileSync(script, "#!/bin/sh\nexit 1\n", "utf-8");
    chmodSync(script, 0o755);
    const r = await runStatusLine({ type: "command", command: script }, samplePayload(), { cwd: dir });
    expect(r.ok).toBe(false);
  });

  it("receives the payload JSON on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "statusline-"));
    dirs.push(dir);
    const script = join(dir, "echo.sh");
    // Echo back the session_id field so we can prove stdin carried the payload.
    writeFileSync(
      script,
      "#!/bin/sh\npayload=$(cat)\nprintf '%s' \"$payload\" | grep -o 'sess_[a-z0-9]*' | head -1\n",
      "utf-8",
    );
    chmodSync(script, 0o755);
    const r = await runStatusLine({ type: "command", command: script }, samplePayload(), { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("sess_12345678");
  });
});
