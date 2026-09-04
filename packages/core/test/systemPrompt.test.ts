import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/systemPrompt.js";
import type { EnvironmentProvider, EnvironmentSnapshot } from "../src/env.js";

/**
 * Deterministic env provider for tests. The system prompt dynamic suffix
 * depends on host state (cwd, git, time) — without an injected provider
 * the suffix is non-deterministic and would couple tests to the host
 * environment.
 */
const fakeEnv: EnvironmentProvider = {
  async snapshot(cwd: string): Promise<EnvironmentSnapshot> {
    return {
      os: "linux 6.0.0 x64",
      hostname: "ci-runner",
      user: "ci",
      shell: "/bin/bash",
      node: "v20.10.0",
      cwd,
      now: "2025-01-01T00:00:00.000Z",
      timezone: "UTC",
      git: { inRepo: false },
    };
  },
};

const baseCtx = {
  cwd: "/work",
  memory: {},
  plan: undefined,
  toolNames: [] as string[],
  extra: undefined,
  model: "m",
  provider: "anthropic",
  environmentProvider: fakeEnv,
};

describe("buildSystemPrompt static prefix", () => {
  it("starts with the CodePilot role header", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/^# CodePilot/);
    expect(out.staticPrefix).toMatch(/Software Engineering Agent/);
  });

  it("contains every section heading", async () => {
    const out = await buildSystemPrompt(baseCtx);
    for (const heading of [
      "Identity and Environment",
      "Tool-Use Policy",
      "Code Conventions",
      "Planning and Task State",
      "Testing and Verification",
      "Git Etiquette",
      "Memory",
      "Token Efficiency",
      "Communication Style",
      "Safety and Security",
      "Collaboration Modes",
      "Tool Reference",
    ]) {
      expect(out.staticPrefix).toContain(heading);
    }
  });

  it("includes the configured tool list", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["read_file", "bash"] });
    expect(out.staticPrefix).toContain("`read_file`");
    expect(out.staticPrefix).toContain("`bash`");
  });

  it("renders a fallback when no tools are exposed", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: [] });
    expect(out.staticPrefix).toMatch(/no tools exposed/);
  });

  it("appends a project-specific notes block when extra is given", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      extra: "Always run `pnpm test` before finishing.",
    });
    expect(out.staticPrefix).toMatch(/Project-Specific Notes/);
    expect(out.staticPrefix).toContain("Always run `pnpm test` before finishing.");
  });

  it("omits the project-specific notes block when extra is empty/undefined", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, extra: undefined });
    expect(out.staticPrefix).not.toMatch(/Project-Specific Notes/);
  });

  it("the static prefix does NOT include any time/cwd/git memory strings (cache-friendly)", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).not.toContain("<environment>");
    expect(out.staticPrefix).not.toContain("<git>");
    expect(out.staticPrefix).not.toContain("<memory>");
    expect(out.staticPrefix).not.toContain("<plan>");
    expect(out.staticPrefix).not.toContain("<tools>");
  });

  it("rough token count of the static prefix is between 1000 and 12000 tokens", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["bash", "edit_file"] });
    const est = Math.ceil(out.staticPrefix.length / 4);
    // Loose bounds: the §1-13 redesign targets ~4500 tokens; we leave a wide
    // range so the test does not become brittle if a section is later
    // reworded.
    expect(est).toBeGreaterThan(1000);
    expect(est).toBeLessThan(12000);
  });
});

describe("buildSystemPrompt mode paragraphs", () => {
  it("chat mode adds the read-only guidance", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      mode: "chat",
      toolNames: ["read_file"],
    });
    expect(out.staticPrefix).toMatch(/Mode: `chat`/);
    expect(out.staticPrefix).toMatch(/read-only/);
    expect(out.staticPrefix).toMatch(/Do not modify the codebase/);
    // Tool list reflects filtered tools.
    expect(out.staticPrefix).toContain("`read_file`");
  });

  it("plan mode adds the planning guidance", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      mode: "plan",
      toolNames: ["read_file", "plan_update"],
    });
    expect(out.staticPrefix).toMatch(/Mode: `plan`/);
    expect(out.staticPrefix).toMatch(/`plan_update`/);
    expect(out.staticPrefix).toMatch(/read-only exploration/);
  });

  it("agent mode adds the full-autonomy guidance", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, mode: "agent", toolNames: ["bash"] });
    expect(out.staticPrefix).toMatch(/Mode: `agent`/);
    expect(out.staticPrefix).toMatch(/Principle of least surprise/);
  });

  it("defaults to agent when omitted", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Mode: `agent`/);
  });

  it("the mode paragraph is part of the static prefix (cache-friendly)", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, mode: "plan" });
    expect(out.staticPrefix).toMatch(/Mode: `plan`/);
    expect(out.dynamicSuffix).not.toMatch(/Mode: `plan`/);
  });
});

describe("buildSystemPrompt dynamic suffix", () => {
  it("contains an <environment> block with key fields", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.dynamicSuffix).toContain("<environment>");
    expect(out.dynamicSuffix).toContain("os: linux 6.0.0 x64");
    expect(out.dynamicSuffix).toContain("cwd: /work");
    expect(out.dynamicSuffix).toContain("now: 2025-01-01T00:00:00.000Z");
    expect(out.dynamicSuffix).toContain("</environment>");
  });

  it("contains a <git> block reflecting the env provider", async () => {
    const inRepo: EnvironmentProvider = {
      async snapshot(cwd) {
        return {
          os: "x",
          hostname: "h",
          user: "u",
          shell: "/bin/sh",
          node: "v0",
          cwd,
          now: "t",
          timezone: "UTC",
          git: {
            inRepo: true,
            root: "/work",
            branch: "main",
            dirty: true,
            lastCommit: "abc1234",
            lastCommitSha: "abc1234",
            statusShort: "## main\n M foo.ts",
          },
        };
      },
    };
    const out = await buildSystemPrompt({ ...baseCtx, environmentProvider: inRepo });
    expect(out.dynamicSuffix).toContain("<git>");
    expect(out.dynamicSuffix).toContain("in_repo: true");
    expect(out.dynamicSuffix).toContain("branch: main");
    expect(out.dynamicSuffix).toContain("dirty: true");
    expect(out.dynamicSuffix).toContain("last_commit: abc1234");
    expect(out.dynamicSuffix).toContain("</git>");
  });

  it("falls back to a not-a-git message when git.inRepo is false", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.dynamicSuffix).toContain("not a git working tree");
  });

  it("contains a <memory> block with project and user sections when present", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      memory: { project: "P", user: "U" },
    });
    expect(out.dynamicSuffix).toContain("<memory>");
    expect(out.dynamicSuffix).toContain("### Project (CODEPILOT.md)");
    expect(out.dynamicSuffix).toContain("P");
    expect(out.dynamicSuffix).toContain("### User (~/.codepilot/MEMORY.md)");
    expect(out.dynamicSuffix).toContain("U");
    expect(out.dynamicSuffix).toContain("</memory>");
  });

  it("memory block falls back to 'no memory files yet' when both are empty", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.dynamicSuffix).toContain("no memory files yet");
  });

  it("contains a <plan> block that mirrors the input plan with status markers", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      plan: [
        { id: "a", title: "first", status: "completed" },
        { id: "b", title: "second", status: "in_progress" },
        { id: "c", title: "third", status: "pending" },
        { id: "d", title: "fourth", status: "blocked" },
      ],
    });
    expect(out.dynamicSuffix).toContain("<plan>");
    expect(out.dynamicSuffix).toContain("[x] a — first (completed)");
    expect(out.dynamicSuffix).toContain("[~] b — second (in_progress)");
    expect(out.dynamicSuffix).toContain("[ ] c — third (pending)");
    expect(out.dynamicSuffix).toContain("[!] d — fourth (blocked)");
    expect(out.dynamicSuffix).toContain("</plan>");
  });

  it("plan block falls back to a hint when no plan exists", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, plan: undefined });
    expect(out.dynamicSuffix).toContain("(no plan yet");
  });

  it("contains a <tools> block listing the configured tool names", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["bash", "edit_file"],
    });
    expect(out.dynamicSuffix).toContain("<tools>");
    expect(out.dynamicSuffix).toContain("- bash");
    expect(out.dynamicSuffix).toContain("- edit_file");
    expect(out.dynamicSuffix).toContain("</tools>");
  });
});

describe("buildSystemPrompt result composition", () => {
  it("full = staticPrefix + dynamicSuffix", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.full).toContain(out.staticPrefix);
    expect(out.full).toContain(out.dynamicSuffix);
    // dynamicSuffix should come after staticPrefix.
    expect(out.full.indexOf(out.dynamicSuffix)).toBeGreaterThan(
      out.full.indexOf(out.staticPrefix)
    );
  });
});
