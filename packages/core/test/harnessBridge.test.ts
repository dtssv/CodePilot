// Tests for the harness_bridge tool: command construction, JSON output
// extraction, subprocess execution (echo harness), timeout, truncation,
// and error handling. Sandbox mode "off" throughout — no real harness CLIs
// are required (custom harnesses use /bin/sh builtins).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  harnessBridgeTool,
  buildHarnessCommand,
  extractHarnessOutput,
} from "../src/tools/harnessBridge.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

describe("buildHarnessCommand", () => {
  it("builds the claude-code one-shot command with a quoted prompt", () => {
    const r = buildHarnessCommand({ harness: "claude-code", prompt: "fix the bug" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toBe("claude -p --output-format json 'fix the bug'");
    }
  });

  it("builds the codex exec command", () => {
    const r = buildHarnessCommand({ harness: "codex", prompt: "add tests" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toBe("codex exec 'add tests'");
    }
  });

  it("shell-quotes prompts containing quotes and shell metacharacters", () => {
    const r = buildHarnessCommand({
      harness: "codex",
      prompt: "it's got $HOME and `backticks`; rm -rf /",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Single-quote style: no unquoted metacharacters survive.
      expect(r.command).toBe(
        "codex exec 'it'\\''s got $HOME and `backticks`; rm -rf /'"
      );
    }
  });

  it("builds a custom command with extra args before the prompt", () => {
    const r = buildHarnessCommand({
      harness: "custom",
      custom_command: "my-agent",
      custom_args: ["--mode", "fast"],
      prompt: "do the thing",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toBe("my-agent '--mode' 'fast' 'do the thing'");
    }
  });

  it("rejects a custom harness without custom_command", () => {
    const r = buildHarnessCommand({ harness: "custom", prompt: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("custom_command");
  });

  it("rejects an unknown harness", () => {
    const r = buildHarnessCommand({
      harness: "nope" as never,
      prompt: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown harness");
  });
});

describe("extractHarnessOutput", () => {
  it("parses claude-code's JSON envelope and returns the result field", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "all done",
      is_error: false,
    });
    expect(extractHarnessOutput("claude-code", stdout)).toBe("all done");
  });

  it("falls back to raw stdout when claude-code output is not JSON", () => {
    expect(extractHarnessOutput("claude-code", "plain text out")).toBe(
      "plain text out"
    );
  });

  it("returns raw stdout for codex and custom", () => {
    expect(extractHarnessOutput("codex", "raw codex out")).toBe("raw codex out");
    expect(extractHarnessOutput("custom", "raw custom out")).toBe("raw custom out");
  });
});

describe("harness_bridge execution", () => {
  let dir: string;
  const ctx = (): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir ?? "/tmp"),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cpharness-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a custom echo harness and returns its stdout", async () => {
    const r = await harnessBridgeTool.execute(
      {
        harness: "custom",
        custom_command: "echo harness-says:",
        prompt: "hello world",
      },
      ctx()
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("harness-says: hello world");
  });

  it("captures stderr and non-zero exit codes as errors", async () => {
    const r = await harnessBridgeTool.execute(
      {
        harness: "custom",
        custom_command: "sh",
        custom_args: ["-c", "echo oops >&2; exit 3; echo"],
        prompt: "",
      },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("[exit 3]");
    expect(r.content).toContain("oops");
  });

  it("reports command-not-found for a missing CLI", async () => {
    const r = await harnessBridgeTool.execute(
      {
        harness: "custom",
        custom_command: "definitely-not-a-real-cli-xyz",
        prompt: "hi",
      },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exit 127|not found|ENOENT/);
  });

  it("enforces the timeout and kills the subprocess", async () => {
    const start = Date.now();
    const r = await harnessBridgeTool.execute(
      {
        harness: "custom",
        custom_command: "sh",
        custom_args: ["-c", "sleep 60"],
        prompt: "",
        timeout_ms: 500,
      },
      ctx()
    );
    const elapsed = Date.now() - start;
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timed out after 500ms");
    // Should have been killed promptly, not after the full 60s sleep.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("truncates output at 100KB", async () => {
    // Emit ~200KB of 'x' on stdout via a POSIX one-liner.
    const r = await harnessBridgeTool.execute(
      {
        harness: "custom",
        custom_command: "sh",
        custom_args: [
          "-c",
          "head -c 200000 /dev/zero | tr '\\0' x; echo",
        ],
        prompt: "",
      },
      ctx()
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("output truncated at 102,400 chars");
    expect(r.content.length).toBeLessThan(110_000);
  }, 15_000);

  it("errors when custom_command is missing for a custom harness", async () => {
    const r = await harnessBridgeTool.execute(
      { harness: "custom", prompt: "hi" },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("custom_command");
  });

  it("reports an unknown harness as an error", async () => {
    const r = await harnessBridgeTool.execute(
      { harness: "wat" as never, prompt: "hi" },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown harness");
  });

  it("extracts claude-code JSON envelopes end-to-end (fake claude CLI)", async () => {
    // Stand in for the real `claude` binary: a PATH shim that prints a
    // claude-style JSON envelope. Verifies the tool's claude-code parsing
    // path without requiring the actual CLI.
    const shim = join(dir, "fake-claude.sh");
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(
      shim,
      '#!/bin/sh\nprintf \'%s\' \'{"type":"result","result":"shim says hi","is_error":false}\'\n'
    );
    await chmod(shim, 0o755);
    const r = await harnessBridgeTool.execute(
      {
        harness: "custom",
        custom_command: shim,
        custom_args: [],
        prompt: "ignored",
      },
      ctx()
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("shim says hi");
  });
});
