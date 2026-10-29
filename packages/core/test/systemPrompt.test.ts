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

  it("requires researching the target before mutating", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Research the target thoroughly before you mutate/);
    expect(out.staticPrefix).toMatch(/study → implement/);
  });

  it("carries the evidence/honesty discipline (anti-laziness rules)", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Evidence and Honesty/);
    expect(out.staticPrefix).toMatch(/Evidence before synthesis/);
    expect(out.staticPrefix).toMatch(/Comparisons are two-sided/);
    expect(out.staticPrefix).toMatch(/Follow the user's explicit constraints exactly/);
    expect(out.staticPrefix).toMatch(/Self-check before you conclude/);
  });

  it("splits brownfield vs greenfield conventions", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Brownfield \(default\)/);
    expect(out.staticPrefix).toMatch(/Greenfield \(no prior code/);
    expect(out.staticPrefix).toMatch(/fully research/);
    expect(out.staticPrefix).toMatch(/Do not build a screenshot\/CDP harness as step 1/);
  });

  it("teaches plan quality: research → implement → verify", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Plan quality/);
    expect(out.staticPrefix).toMatch(/Do not plan verification you cannot perform/);
    expect(out.staticPrefix).toMatch(/edit → screenshot → edit/);
    expect(out.staticPrefix).toMatch(/research\/study/);
  });

  it("distinguishes code correctness from feature\/visual correctness", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Code correctness ≠ feature \/ visual correctness/);
    expect(out.staticPrefix).toMatch(/Define success before volume/);
    expect(out.staticPrefix).toMatch(/Verify at milestones, not after every edit/);
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

  it("advertises discovered skills in the stable cached block", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      skills: [
        { name: "commit", description: "write a commit message", source: "project", path: "/x/SKILL.md", body: "do the thing", when: undefined, tools: undefined } as never,
      ],
    });
    // Skills ride in the stable (cached) tier, not the static prefix.
    expect(out.stableContext).toContain("<skills>");
    expect(out.stableContext).toContain("`commit`");
    expect(out.stableContext).toMatch(/skill` tool/);
    // No skills → no section.
    const empty = await buildSystemPrompt({ ...baseCtx, skills: [] });
    expect(empty.stableContext).not.toContain("<skills>");
  });

  it("renders a fallback when no tools are exposed", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: [] });
    expect(out.staticPrefix).toMatch(/none — reason only|no tools exposed/);
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
    expect(out.dynamicSuffix).toContain("scratch_dir:");
    expect(out.dynamicSuffix).toContain("project_state_dir:");
    // `now` is volatile and no longer inside <environment>.
    expect(out.volatileSuffix).toContain("now: 2025-01-01T00:00:00.000Z");
    expect(out.dynamicSuffix).toContain("</environment>");
  });

  it("advertises scratch and project state when provided", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      scratchDir: "/home/u/.codepilot/projects/abc/scratch/s1",
      projectStateDir: "/home/u/.codepilot/projects/abc",
    });
    expect(out.dynamicSuffix).toContain(
      "scratch_dir: /home/u/.codepilot/projects/abc/scratch/s1",
    );
    expect(out.dynamicSuffix).toContain(
      "project_state_dir: /home/u/.codepilot/projects/abc",
    );
    expect(out.staticPrefix).toContain("scratch_dir");
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
    expect(out.dynamicSuffix).toContain("last_commit: abc1234");
    expect(out.dynamicSuffix).toContain("</git>");
    // Dirty working-tree is volatile now, not in the stable <git> identity.
    expect(out.volatileSuffix).toContain("working_tree: 1 changed file(s)");
  });

  it("falls back to a not-a-git message when git.inRepo is false", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.dynamicSuffix).toContain("not a git working tree");
  });

  it("injects the progressive index and advertises project/user memory paths (not full text)", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      memory: {
        project: "## Section A\nproject-body-text",
        user: "## Pref\nuser-body-text",
        progressive: "INDEX",
      },
    });
    expect(out.dynamicSuffix).toContain("<memory>");
    expect(out.dynamicSuffix).toContain("### Progressive index");
    expect(out.dynamicSuffix).toContain("INDEX");
    // Project/user memory are advertised by path + headings, not pasted in full.
    expect(out.dynamicSuffix).toContain("Project memory available");
    expect(out.dynamicSuffix).toContain("User memory available");
    expect(out.dynamicSuffix).toContain("## Section A");
    expect(out.dynamicSuffix).not.toContain("project-body-text");
    expect(out.dynamicSuffix).not.toContain("user-body-text");
    expect(out.dynamicSuffix).toContain("</memory>");
  });

  it("does not inject project/user memory bodies into the per-turn suffix", async () => {
    const body = "secret-long-note ".repeat(100);
    const out = await buildSystemPrompt({
      ...baseCtx,
      memory: { user: `## Heading\n${body}` },
    });
    expect(out.dynamicSuffix).toContain("User memory available");
    expect(out.dynamicSuffix).toContain("read_file");
    // The body must never be injected verbatim.
    expect(out.dynamicSuffix).not.toContain(body.trim());
  });

  it("reports git working tree as a count only, never the file list", async () => {
    const changes = Array.from({ length: 30 }, (_, i) => ` M file${i}.ts`).join("\n");
    const provider: EnvironmentProvider = {
      async snapshot(cwd) {
        return {
          os: "x", hostname: "h", user: "u", shell: "/bin/sh", node: "v0", cwd,
          now: "t", timezone: "UTC",
          git: { inRepo: true, root: "/w", branch: "main", dirty: true, statusShort: `## main\n${changes}` },
        };
      },
    };
    const out = await buildSystemPrompt({ ...baseCtx, environmentProvider: provider });
    expect(out.volatileSuffix).toContain("30 changed file(s)");
    expect(out.volatileSuffix).toContain("git status");
    // No individual paths are listed anywhere in the context.
    expect(out.full).not.toContain("file0.ts");
    expect(out.full).not.toContain("file29.ts");
  });

  it("does not inject a project_tree block in the per-turn suffix", async () => {
    const provider: EnvironmentProvider = {
      async snapshot(cwd) {
        return {
          os: "x", hostname: "h", user: "u", shell: "/bin/sh", node: "v0", cwd,
          now: "t", timezone: "UTC",
          directoryTree: "src/\n  a.ts\n  b.ts",
          git: { inRepo: false },
        };
      },
    };
    const out = await buildSystemPrompt({ ...baseCtx, environmentProvider: provider });
    expect(out.dynamicSuffix).not.toContain("<project_tree>");
    expect(out.dynamicSuffix).not.toContain("a.ts");
  });

  it("documents progressive disclosure in the static memory section", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toContain("progressive disclosure");
    expect(out.staticPrefix).toContain("Topic files");
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
    expect(out.volatileSuffix).toContain("<plan>");
    expect(out.volatileSuffix).toContain("[x] a — first (completed)");
    expect(out.volatileSuffix).toContain("[~] b — second (in_progress)");
    expect(out.volatileSuffix).toContain("[ ] c — third (pending)");
    expect(out.volatileSuffix).toContain("[!] d — fourth (blocked)");
    expect(out.volatileSuffix).toContain("</plan>");
  });

  it("plan block falls back to a hint when no plan exists", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, plan: undefined });
    expect(out.volatileSuffix).toContain("(no plan yet");
  });

  it("keeps the stable context byte-identical when only volatile state changes", async () => {
    // Two snapshots differing ONLY in `now`, git dirty count, and plan — the
    // stable context must stay byte-for-byte identical so the cached system
    // block (staticPrefix + stableContext) never busts the prompt cache.
    const mk = (now: string, changed: number, plan: typeof baseCtx.plan) => ({
      ...baseCtx,
      plan,
      environmentProvider: {
        async snapshot(cwd: string) {
          return {
            os: "x", hostname: "h", user: "u", shell: "/bin/sh", node: "v0", cwd,
            now, timezone: "UTC",
            git: {
              inRepo: true, root: "/w", branch: "main",
              statusShort: `## main\n${Array.from({ length: changed }, (_, i) => ` M f${i}.ts`).join("\n")}`,
            },
          };
        },
      } as EnvironmentProvider,
    });
    const a = await buildSystemPrompt(mk("2026-01-01T00:00:00Z", 3, []));
    const b = await buildSystemPrompt(mk("2026-06-30T23:59:59Z", 41, [
      { id: "s", title: "work", status: "in_progress" },
    ]));
    expect(a.staticPrefix).toBe(b.staticPrefix);
    expect(a.stableContext).toBe(b.stableContext); // ← the invariant
    // And the volatile tiers DO differ (sanity: we didn't accidentally freeze them).
    expect(a.volatileSuffix).not.toBe(b.volatileSuffix);
    expect(a.volatileSuffix).toContain("3 changed file(s)");
    expect(b.volatileSuffix).toContain("41 changed file(s)");
  });

  it("does not duplicate the tool list in the suffix (names live in §12 + the tools array)", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["bash", "edit_file"],
    });
    // The redundant <tools> block was removed to avoid re-listing tools every
    // turn (grows with MCP). §12 of the static prefix names them instead.
    expect(out.dynamicSuffix).not.toContain("<tools>");
    expect(out.staticPrefix).toContain("bash");
    expect(out.staticPrefix).toContain("edit_file");
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
