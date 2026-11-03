import { describe, expect, it } from "vitest";
import { buildSystemPrompt, assembleSections, type StaticSection } from "../src/systemPrompt.js";
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
    expect(out.staticPrefix).toMatch(/Research before you mutate/);
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
    expect(out.staticPrefix).toMatch(/Do not stand up heavy verification scaffolding/);
  });

  it("teaches plan quality: research → implement → verify", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["plan_update"] });
    expect(out.staticPrefix).toMatch(/Plan quality/);
    expect(out.staticPrefix).toMatch(/Do not plan verification you cannot perform/);
    expect(out.staticPrefix).toMatch(/edit→check→edit micro-loop/);
    expect(out.staticPrefix).toMatch(/research\/study/);
  });

  it("distinguishes structure checks from behaviour checks", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Structure checks ≠ behaviour checks/);
    expect(out.staticPrefix).toMatch(/Define success before volume/);
    expect(out.staticPrefix).toMatch(/Verify at milestones, not after every edit/);
  });

  it("contains every always-on section heading (tool-independent)", async () => {
    const out = await buildSystemPrompt(baseCtx);
    for (const heading of [
      "Identity and Environment",
      "Tool-Use Policy",
      "Code Conventions",
      "Testing and Verification",
      "Git Etiquette",
      "Token Efficiency",
      "Communication Style",
      "Safety and Security",
      "Collaboration Modes",
      "Tool Reference",
    ]) {
      expect(out.staticPrefix).toContain(heading);
    }
  });

  it("renders the capability-gated sections only when their tool is exposed", async () => {
    // Empty toolset: planning / memory / MCP guidance is absent (teaching a
    // tool the session cannot call is pure waste — philosophy A).
    const bare = await buildSystemPrompt(baseCtx);
    expect(bare.staticPrefix).not.toContain("Planning and Task State");
    expect(bare.staticPrefix).not.toContain("## Memory");
    expect(bare.staticPrefix).not.toContain("External Context (MCP)");
    // Expose the tools: the matching sections appear.
    const full = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["plan_update", "memory_write", "mcp__github__search"],
    });
    expect(full.staticPrefix).toContain("Planning and Task State");
    expect(full.staticPrefix).toContain("## Memory");
    expect(full.staticPrefix).toContain("External Context (MCP)");
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
    // The Memory section is capability-gated on `memory_write` (philosophy A).
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["memory_write"] });
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

// C4 contract tests: assert behaviour, not wording. These guard the invariants
// the Section-registry redesign must preserve — tool/prompt consistency (D1),
// required-section presence (D2), on top of the cache-stability and
// token-budget contracts already covered above.
describe("buildSystemPrompt C4 contracts", () => {
  // Tools whose usage policy the static prefix hard-codes (§2). Each must be in
  // the exposed tool set whenever the prompt instructs the model to use it.
  const TOOL_POLICY_MENTIONS = [
    "read_file",
    "edit_file",
    "write_file",
    "grep",
    "glob",
    "bash",
    "task",
    "read_artifact",
    "read_image",
    "web_fetch",
  ];

  it("required sections are present under every mode", async () => {
    for (const mode of ["chat", "plan", "agent"] as const) {
      const out = await buildSystemPrompt({ ...baseCtx, mode, toolNames: ["read_file"] });
      expect(out.staticPrefix, `identity missing in ${mode}`).toContain("Identity and Environment");
      expect(out.staticPrefix, `evidence/honesty missing in ${mode}`).toContain("Evidence and Honesty");
      expect(out.staticPrefix, `safety missing in ${mode}`).toContain("Safety and Security");
    }
  });

  // Extract the "## 2. Tool-Use Policy" block — the section whose backticked
  // tool mentions are instructions to USE a tool (unlike §11 mode guidance,
  // which names tools to say they are absent). The tool-consistency contract
  // applies to this block.
  function toolUsePolicyBlock(staticPrefix: string): string {
    const start = staticPrefix.indexOf("## Tool-Use Policy");
    expect(start, "Tool-Use Policy heading not found").toBeGreaterThanOrEqual(0);
    const after = staticPrefix.indexOf("\n## ", start + 1);
    return staticPrefix.slice(start, after === -1 ? undefined : after);
  }

  it("tool-consistency: the Tool-Use Policy must not instruct using a tool that is not exposed (D1)", async () => {
    // chat mode exposes only read-only tools. The §2 policy must drop any bullet
    // that instructs using a write/execute/delegate tool the mode did not expose.
    const exposed = ["read_file", "glob", "grep", "ls", "read_artifact", "web_fetch", "web_search", "bash_output"];
    const out = await buildSystemPrompt({ ...baseCtx, mode: "chat", toolNames: exposed });
    const block = toolUsePolicyBlock(out.staticPrefix);
    const offenders = TOOL_POLICY_MENTIONS.filter(
      (tool) => !exposed.includes(tool) && block.includes(`\`${tool}\``),
    );
    expect(offenders, `§2 references unexposed tools in chat mode: ${offenders.join(", ")}`).toEqual([]);
  });

  it("tool-consistency: full agent toolset keeps the tool-bound bullets", async () => {
    const exposed = ["read_file", "edit_file", "write_file", "bash", "task", "read_artifact", "grep", "glob"];
    const out = await buildSystemPrompt({ ...baseCtx, mode: "agent", toolNames: exposed });
    const block = toolUsePolicyBlock(out.staticPrefix);
    // The task-delegation and permission-denied bullets are tool-bound and should
    // be present when their tools are exposed. (Single-tool mechanics like
    // "prefer edit_file over write_file" now live in each tool's description,
    // not in the cross-tool policy — C5 downlift to schema.)
    expect(block).toContain("`task`");
    expect(block).toContain("Permission denied");
  });

  // C4 writing-rule C (consolidated red lines + decidable conditions):
  // negative rules are collected into a `Never:` line per section, and vague
  // qualifiers are replaced by decidable conditions.
  it("red lines: §2 and §5 carry a consolidated Never: line", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["read_file", "edit_file", "bash"] });
    const neverLines = out.staticPrefix.match(/^Never: /gm) ?? [];
    expect(neverLines.length, "expected consolidated Never: lines in §2 and §5").toBeGreaterThanOrEqual(2);
  });

  it("decidable conditions: planning uses ≥3-steps, not the vague 'non-trivial task'", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["read_file", "plan_update"] });
    expect(out.staticPrefix).toContain("≥3 distinct steps");
    // The planning rule no longer hinges on the undecidable "non-trivial".
    const planStart = out.staticPrefix.indexOf("## Planning and Task State");
    expect(planStart, "Planning section not found").toBeGreaterThanOrEqual(0);
    const planEnd = out.staticPrefix.indexOf("\n## ", planStart + 1);
    const planBlock = out.staticPrefix.slice(planStart, planEnd);
    expect(planBlock).not.toMatch(/non-trivial task/);
  });

  // C4 writing-rule B (single source of truth): a rule has one home. The
  // re-read/fold-exception rule is owned by §2; other sections must point to it,
  // not restate it. Guards against the cross-section duplication C4 flagged.
  it("dedup: the fold-exception re-read rule appears once (owned by §2)", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["read_file", "edit_file", "bash"] });
    const foldMentions = out.staticPrefix.match(/folded away|fold stub/g) ?? [];
    // §2's bullet uses "folded away" + "fold stub"; no other section should
    // restate the fold exception. Allow the single §2 bullet (≤2 phrase hits).
    expect(foldMentions.length, "fold-exception rule restated outside §2").toBeLessThanOrEqual(2);
  });
});

// C4 step 2: the Section registry enforces (not just documents) uniqueness,
// ordering, and per-model override.
describe("section registry (assembleSections)", () => {
  const s = (name: string, order: number, text: string, source?: "core" | "model"): StaticSection =>
    ({ name, order, source, text });

  it("orders by `order` then name, and joins with blank lines", () => {
    const out = assembleSections([s("b", 2, "B"), s("a", 1, "A"), s("c", 1, "C")]);
    // order 1 before 2; within order 1, name "a" before "c".
    expect(out).toBe("A\n\nC\n\nB\n");
  });

  it("throws on two core sections with the same name", () => {
    expect(() => assembleSections([s("dup", 0, "X"), s("dup", 1, "Y")])).toThrow(/duplicate/);
  });

  it("lets a model section override the core section of the same name", () => {
    const out = assembleSections([
      s("tool-use", 0, "CORE tool policy", "core"),
      s("tool-use", 0, "TERSE tool policy", "model"),
    ]);
    expect(out).toContain("TERSE tool policy");
    expect(out).not.toContain("CORE tool policy");
  });

  it("rejects a core trying to override a model (only model overrides core)", () => {
    expect(() =>
      assembleSections([s("x", 0, "M", "model"), s("x", 1, "C", "core")]),
    ).toThrow(/duplicate/);
  });

  // Philosophy A: capability-gated sections render only when every required
  // tool is in `have`. A section with no `requires` is always rendered.
  it("drops a section whose `requires` tool is absent, keeps it when present", () => {
    const sections: StaticSection[] = [
      { name: "always", order: 0, text: "ALWAYS" },
      { name: "gated", order: 1, requires: ["plan_update"], text: "GATED" },
    ];
    expect(assembleSections(sections, new Set(["read_file"]))).not.toContain("GATED");
    expect(assembleSections(sections, new Set(["read_file"]))).toContain("ALWAYS");
    expect(assembleSections(sections, new Set(["plan_update"]))).toContain("GATED");
  });

  it("renders every section when no `have` set is passed (back-compat)", () => {
    const sections: StaticSection[] = [
      { name: "gated", order: 0, requires: ["plan_update"], text: "GATED" },
    ];
    expect(assembleSections(sections)).toContain("GATED");
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
