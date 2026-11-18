import { describe, expect, it } from "vitest";
import { buildSystemPrompt, assembleSections, type StaticSection } from "../src/systemPrompt/index.js";
import type { EnvironmentProvider, EnvironmentSnapshot } from "../src/config/env.js";
import { taskTool } from "../src/tools/task.js";

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
      platform: "linux",
      arch: "x64",
      release: "6.0.0",
      hostname: "ci-runner",
      user: "ci",
      shell: "/bin/bash",
      node: "v20.10.0",
      cwd,
      now: "2025-01-01T00:00:00Z",
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
    expect(out.staticPrefix).not.toMatch(/study phase/);
    expect(out.staticPrefix).not.toMatch(/study → implement/);
  });

  it("subagent prompts use dedicated specialist templates, not parent block assembly", async () => {
    const parent = await buildSystemPrompt({ ...baseCtx, mode: "agent" });
    expect(parent.volatileSuffix).toContain("Collaboration Modes");
    expect(parent.volatileSuffix).toMatch(/Keep calling tools while work remains/);
    expect(parent.staticPrefix).toMatch(/Do not yield early just to wait/);
    expect(parent.staticPrefix).toMatch(/Unclear asks in a code workspace/);
    expect(parent.staticPrefix).toMatch(/Git Etiquette/);
    expect(parent.staticPrefix).toMatch(/Tone and style/);

    const explore = await buildSystemPrompt({
      ...baseCtx,
      mode: "agent",
      subagent: true,
      subagentProfile: "explore",
    });
    expect(explore.volatileSuffix).not.toContain("Worker turn");
    expect(explore.volatileSuffix).not.toContain("Collaboration Modes");
    expect(explore.volatileSuffix).toMatch(/role: subagent/);
    expect(explore.volatileSuffix).toMatch(/profile: explore/);
    expect(explore.staticPrefix).toMatch(/Explore sub-agent/);
    expect(explore.staticPrefix).toMatch(/READ-ONLY/);
    expect(explore.staticPrefix).toMatch(/Throwaway \*\*read-only\*\* search specialist/);
    expect(explore.staticPrefix).toMatch(/do not force a code-edit framing/i);
    expect(explore.staticPrefix).toMatch(/\*\*Safety\.\*\*/);
    expect(explore.staticPrefix).toMatch(/task footer/);
    expect(explore.staticPrefix).toMatch(/\*\*Conclusion\.\*\*/);
    expect(explore.staticPrefix).not.toMatch(/### Findings/);
    expect(explore.staticPrefix).not.toMatch(/Project-Specific Notes/);
    expect(explore.staticPrefix).not.toMatch(/Unclear asks in a code workspace/);
    expect(explore.staticPrefix).not.toMatch(/# Doing tasks/);
    expect(explore.staticPrefix).not.toMatch(/Git Etiquette/);
    expect(explore.staticPrefix).not.toMatch(/Tone and style/);
    expect(explore.staticPrefix).not.toMatch(/Code Conventions/);
    expect(explore.staticPrefix).not.toMatch(/Testing and Verification/);
    expect(explore.staticPrefix).not.toMatch(/Research before you mutate/);
    expect(explore.staticPrefix).not.toMatch(/## Sub-Agent Role/);
    expect(explore.staticPrefix.length).toBeLessThan(2200);

    const worker = await buildSystemPrompt({
      ...baseCtx,
      mode: "agent",
      subagent: true,
      subagentProfile: "worker",
      toolNames: ["bash", "edit_file", "read_file"],
    });
    expect(worker.staticPrefix).toMatch(/Worker sub-agent/);
    expect(worker.staticPrefix).toMatch(/Verify/);
    expect(worker.staticPrefix).not.toMatch(/Code Conventions/);
    expect(worker.staticPrefix).not.toMatch(/Testing and Verification/);
    expect(worker.staticPrefix.length).toBeGreaterThan(explore.staticPrefix.length);
    expect(worker.staticPrefix.length).toBeLessThan(2800);

    const plan = await buildSystemPrompt({
      ...baseCtx,
      mode: "agent",
      subagent: true,
      subagentProfile: "plan",
    });
    expect(plan.staticPrefix).toMatch(/Plan sub-agent/);
    expect(plan.staticPrefix).toMatch(/task footer/);
    expect(plan.staticPrefix).not.toMatch(/### Plan/);
    expect(plan.staticPrefix).not.toMatch(/### Findings/);
  });

  it("keeps task principles in system; API knobs live on the task tool", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["task", "read_file", "grep", "ask_user_question", "read_artifact"],
    });
    // Principles stay in the static prefix…
    expect(out.staticPrefix).toMatch(/Trust what `task` returns/);
    expect(out.staticPrefix).toMatch(/Sample-verify/);
    expect(out.staticPrefix).toMatch(/summarise and stop/);
    expect(out.staticPrefix).toMatch(/continue_session_id/);
    expect(out.staticPrefix).toMatch(/Ask the user vs explore/);
    expect(out.staticPrefix).toMatch(/Instruction priority/);
    expect(out.staticPrefix).toMatch(/sandbox \/ permission \/ mode marks/);
    expect(out.staticPrefix).toMatch(/explicitly asks to spawn/);
    expect(out.staticPrefix).toMatch(/\*\*one\*\* OBJECTIVE/);
    expect(out.staticPrefix).toMatch(/Blocker/);
    expect(out.staticPrefix).toMatch(/at most once/);
    // …API manuals and regression examples do not.
    expect(out.staticPrefix).not.toMatch(/omit_memory: true/);
    expect(out.staticPrefix).not.toMatch(/subagentMaxThreads/);
    expect(out.staticPrefix).not.toMatch(/cannot grant parent-only/);
    expect(out.staticPrefix).not.toMatch(/ping then telnet/);
    expect(out.staticPrefix).not.toMatch(/do not re-grep to double-check/);
    // API knobs belong on the task tool description (single home).
    expect(taskTool.description).toMatch(/omit_memory: true/);
    expect(taskTool.description).toMatch(/subagentMaxThreads/);
    expect(taskTool.description).toMatch(/cannot grant parent-only/);
    expect(taskTool.description).toMatch(/fork_max_tokens/);
  });

  it("gates long-horizon goal guidance on start_goal", async () => {
    const bare = await buildSystemPrompt(baseCtx);
    expect(bare.staticPrefix).not.toContain("Long-horizon goals");
    const withGoal = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["start_goal", "plan_update"],
    });
    expect(withGoal.staticPrefix).toContain("Long-horizon goals");
    expect(withGoal.staticPrefix).toMatch(/Ordinary refactors/);
  });

  it("carries the evidence/honesty discipline (anti-laziness rules)", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toMatch(/Evidence and Honesty/);
    expect(out.staticPrefix).toMatch(/Evidence before synthesis/);
    expect(out.staticPrefix).toMatch(/Never infer this repo lacks X/);
    expect(out.staticPrefix).not.toMatch(/Comparisons are two-sided/);
    expect(out.staticPrefix).toMatch(/Obey named paths\/commands exactly/);
    expect(out.staticPrefix).toMatch(/prefer "unverified" over guessing/);
  });

  it("splits brownfield vs greenfield conventions", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["read_file", "edit_file"],
    });
    expect(out.staticPrefix).toMatch(/brownfield default/);
    expect(out.staticPrefix).toMatch(/Greenfield/);
    expect(out.staticPrefix).toMatch(/gates are concrete/);
    expect(out.staticPrefix).toMatch(/something real to exercise/);
    const readOnly = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["read_file", "grep"],
    });
    expect(readOnly.staticPrefix).not.toContain("Code Conventions");
  });

  it("keeps planning principles in the static prefix; field detail on plan_update", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["plan_update"] });
    expect(out.staticPrefix).toMatch(/One primary tracker/);
    expect(out.staticPrefix).toMatch(/Plan when ≥3 mutate\/verify\/decision/);
    expect(out.staticPrefix).toMatch(/do \*\*not\*\* count/);
    expect(out.staticPrefix).toMatch(/plan-only turn/);
    expect(out.staticPrefix).not.toMatch(/Layers \(do not double-track\)/);
    expect(out.staticPrefix).not.toMatch(/teach by contrast/);
    expect(out.staticPrefix).not.toMatch(/research\/study/);
    expect(out.staticPrefix).not.toMatch(/easiest ~25%/);
    const { planUpdateTool } = await import("../src/tools/plan_update.js");
    expect(planUpdateTool.description).toMatch(/non-file outcome/);
    expect(planUpdateTool.description).toMatch(/start_goal/);
  });

  it("gates testing guidance on mutating tools", async () => {
    const readOnly = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["read_file", "grep", "glob"],
    });
    expect(readOnly.staticPrefix).not.toContain("Testing and Verification");
    const withMutators = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["read_file", "edit_file", "bash"],
    });
    expect(withMutators.staticPrefix).toContain("Testing and Verification");
    expect(withMutators.staticPrefix).toMatch(/Structure ≠ behaviour/);
    expect(withMutators.staticPrefix).toMatch(/Verify at milestones/);
    expect(withMutators.staticPrefix).toMatch(/Done when:/);
    expect(withMutators.staticPrefix).not.toMatch(/No automated behaviour tests/);
  });

  it("contains every always-on section heading (tool-independent)", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["read_file", "edit_file", "bash"],
    });
    for (const heading of [
      "CodePilot — Software Engineering Agent",
      "# System",
      "# Doing tasks",
      "Tool-Use Policy",
      "Code Conventions",
      "Testing and Verification",
      "Git Etiquette",
      "# Tone and style",
      "Safety and Security",
      "Done when:",
    ]) {
      expect(out.staticPrefix).toContain(heading);
    }
    expect(out.staticPrefix).not.toContain("# Output efficiency");
    expect(out.staticPrefix).not.toContain("Tool Reference");
    // Collaboration Modes is session-variant: it rides the volatile tail so a
    // mode switch does not bust the cached prefix.
    expect(out.staticPrefix).not.toContain("Collaboration Modes");
    expect(out.volatileSuffix).toContain("Collaboration Modes");
  });

  it("renders the capability-gated sections only when their tool is exposed", async () => {
    // Empty toolset: planning / memory / MCP guidance is absent (teaching a
    // tool the session cannot call is pure waste — philosophy A).
    const bare = await buildSystemPrompt(baseCtx);
    expect(bare.staticPrefix).not.toContain("Planning and Task State");
    expect(bare.staticPrefix).not.toContain("# Memory");
    expect(bare.staticPrefix).not.toContain("External Context (MCP)");
    // Expose the tools: the matching sections appear.
    const full = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["plan_update", "memory_write", "mcp__github__search"],
    });
    expect(full.staticPrefix).toContain("Planning and Task State");
    expect(full.staticPrefix).toContain("# Memory");
    expect(full.staticPrefix).toContain("External Context (MCP)");
  });

  it("does not duplicate the tool-name list in the static prefix (names live in the tools array)", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["read_file", "bash"] });
    // Tool manuals live in each tool's description; system only has cross-tool policy.
    expect(out.staticPrefix).toContain("Each tool's `description` is its manual");
    expect(out.staticPrefix).not.toMatch(/Available tools: `read_file`/);
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

  it("renders without a tool-name list even when no tools are exposed", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: [] });
    expect(out.staticPrefix).toContain("Each tool's `description` is its manual");
    expect(out.staticPrefix).not.toMatch(/Available tools:/);
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

  it("puts sessionNotes in the volatile tail, not the cached prefix", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      sessionNotes: "Sandbox: mode=seatbelt, network=blocked.",
    });
    expect(out.volatileSuffix).toContain("<session_notes>");
    expect(out.volatileSuffix).toContain("Sandbox: mode=seatbelt");
    expect(out.staticPrefix).not.toContain("Sandbox: mode=seatbelt");
    expect(out.stableContext).not.toContain("Sandbox: mode=seatbelt");
  });

  it("surfaces live permissionMode in <runtime>", async () => {
    const ask = await buildSystemPrompt(baseCtx);
    expect(ask.volatileSuffix).toMatch(/permission: ask/);
    const yolo = await buildSystemPrompt({ ...baseCtx, permissionMode: "yolo" });
    expect(yolo.volatileSuffix).toMatch(/permission: yolo/);
    expect(yolo.stableContext).not.toMatch(/permission: yolo/);
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
    expect(out.volatileSuffix).toMatch(/Mode: `chat`/);
    expect(out.volatileSuffix).toMatch(/read-only/);
    expect(out.volatileSuffix).toMatch(/Do not change the codebase/);
 // Tool list reflects filtered tools.
    expect(out.staticPrefix).toContain("`read_file`");
  });

  it("plan mode adds the planning guidance", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      mode: "plan",
      toolNames: ["read_file", "plan_update"],
    });
    expect(out.volatileSuffix).toMatch(/Mode: `plan`/);
    expect(out.volatileSuffix).toMatch(/`plan_update`/);
    expect(out.volatileSuffix).toMatch(/read-only exploration/);
  });

  it("agent mode adds the full-autonomy guidance", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, mode: "agent", toolNames: ["bash"] });
    expect(out.volatileSuffix).toMatch(/Mode: `agent`/);
    expect(out.volatileSuffix).toMatch(/Least surprise/);
  });

  it("defaults to agent when omitted", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.volatileSuffix).toMatch(/Mode: `agent`/);
  });

  it("the mode paragraph rides the volatile tail, not the cached prefix", async () => {
    // Switching mode must NOT change the cached byte prefix: the active mode's
    // guidance lives in the volatile suffix, outside staticPrefix/stableContext.
    const out = await buildSystemPrompt({ ...baseCtx, mode: "plan" });
    expect(out.volatileSuffix).toMatch(/Mode: `plan`/);
    expect(out.staticPrefix).not.toMatch(/Mode: `plan`/);
    expect(out.stableContext).not.toMatch(/Mode: `plan`/);
  });

  it("changing mode leaves the cached prefix byte-identical", async () => {
    const chat = await buildSystemPrompt({ ...baseCtx, mode: "chat", toolNames: ["read_file"] });
    const agent = await buildSystemPrompt({ ...baseCtx, mode: "agent", toolNames: ["read_file"] });
    // Same tool set, different mode → staticPrefix + stableContext unchanged.
    expect(agent.staticPrefix).toBe(chat.staticPrefix);
    expect(agent.stableContext).toBe(chat.stableContext);
    // The volatile tail differs (it carries the active mode).
    expect(agent.volatileSuffix).not.toBe(chat.volatileSuffix);
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
    expect(out.volatileSuffix).toContain("now: 2025-01-01T00:00:00Z");
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
            lastCommit: "abc1234",
            lastCommitSha: "abc1234",
          },
        };
      },
    };
    const out = await buildSystemPrompt({ ...baseCtx, environmentProvider: inRepo });
    expect(out.dynamicSuffix).toContain("<git>");
    expect(out.dynamicSuffix).toContain("in_repo: true");
    expect(out.dynamicSuffix).toContain("branch: main");
    // last_commit is omitted from the stable <git> block (churns on every
    // commit and would bust the prompt cache); agents fetch tip on demand.
    expect(out.dynamicSuffix).not.toContain("last_commit:");
    expect(out.dynamicSuffix).toContain("</git>");
    // Dirty working-tree is not injected (peer parity); only identity lives in <git>.
    expect(out.volatileSuffix).not.toContain("working_tree:");
    expect(out.dynamicSuffix).not.toContain("working_tree:");
  });

  it("falls back to a not-a-git message when git.inRepo is false", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.dynamicSuffix).toContain("not a git working tree");
  });

  it("injects a progressive stub and advertises project/user memory paths (not full text)", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      memory: {
        project: "## Section A\nproject-body-text",
        user: "## Pref\nuser-body-text",
        progressive: "dir: `/mem`\ntopics: 3 · index_bullets: 12",
      },
    });
    expect(out.dynamicSuffix).toContain("<memory>");
    expect(out.dynamicSuffix).toContain("### Progressive memory");
    expect(out.dynamicSuffix).toContain("dir: `/mem`");
    // Lean env: hostname / user / node are not injected.
    expect(out.dynamicSuffix).not.toMatch(/^hostname:/m);
    expect(out.dynamicSuffix).not.toMatch(/^user:/m);
    expect(out.dynamicSuffix).not.toMatch(/^node:/m);
    // Project/user memory are advertised by path + headings, not pasted in full.
    expect(out.dynamicSuffix).toContain("Project memory available");
    expect(out.dynamicSuffix).toContain("User memory available");
    expect(out.dynamicSuffix).toContain("## Section A");
    expect(out.dynamicSuffix).not.toContain("project-body-text");
    expect(out.dynamicSuffix).not.toContain("user-body-text");
    expect(out.dynamicSuffix).toContain("</memory>");
  });

  it("injects workspace instruction files verbatim, ranked in the priority ladder", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      memory: {
        instructions: "<!-- from /repo/AGENTS.md -->\n## Rules\n- Run `pnpm test` before done.",
        project: "## Section A\nproject-body-text",
      },
    });
    expect(out.dynamicSuffix).toContain("<project_instructions>");
    expect(out.dynamicSuffix).toContain("- Run `pnpm test` before done.");
    expect(out.dynamicSuffix).not.toContain("project-body-text");
    expect(out.staticPrefix).toMatch(/3\. \*\*`<project_instructions>`\*\*/);
  });

  it("frames memory headings as a table of contents, not instructions", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      memory: {
        project: "## Use headless Chrome for screenshots\nbody",
        user: "## Some preference\nbody",
        progressive: "dir: `/mem`\ntopics: 1",
      },
    });
    // The heading is still advertised (so the model can read_file it)…
    expect(out.dynamicSuffix).toContain("## Use headless Chrome for screenshots");
    // …but framed as a catalog of past notes, not a to-do list / instruction.
    expect(out.dynamicSuffix).toContain("table of contents");
    expect(out.dynamicSuffix).toContain("not actions to take");
    expect(out.dynamicSuffix).toContain("does not mean use it now");
    // Progressive stub carries the same "reference, not instruction" framing.
    expect(out.dynamicSuffix).toContain("not instructions for this task");
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

  it("does not inject dirty working-tree paths into the prompt", async () => {
    const provider: EnvironmentProvider = {
      async snapshot(cwd) {
        return {
          os: "x", hostname: "h", user: "u", shell: "/bin/sh", node: "v0", cwd,
          now: "t", timezone: "UTC",
          git: { inRepo: true, root: "/w", branch: "main", lastCommitSha: "abc", lastCommit: "wip" },
        };
      },
    };
    const out = await buildSystemPrompt({ ...baseCtx, environmentProvider: provider });
    expect(out.dynamicSuffix).toContain("in_repo: true");
    expect(out.volatileSuffix).toContain("now: t");
    expect(out.volatileSuffix).not.toContain("working_tree:");
    expect(out.full).not.toMatch(/run `git status`/);
  });

  it("does not inject a project_tree block in the per-turn suffix", async () => {
    const provider: EnvironmentProvider = {
      async snapshot(cwd) {
        return {
          os: "x", hostname: "h", user: "u", shell: "/bin/sh", node: "v0", cwd,
          now: "t", timezone: "UTC",
          git: { inRepo: false },
        };
      },
    };
    const out = await buildSystemPrompt({ ...baseCtx, environmentProvider: provider });
    expect(out.dynamicSuffix).not.toContain("<project_tree>");
  });

  it("documents progressive disclosure in the static memory section", async () => {
    // The Memory section is capability-gated on `memory_write` (philosophy A).
    const out = await buildSystemPrompt({ ...baseCtx, toolNames: ["memory_write"] });
    expect(out.staticPrefix).toContain("progressive disclosure");
    expect(out.staticPrefix).toContain("relevant_memories");
    expect(out.staticPrefix).toMatch(/do \*\*not\*\* dump the handbook/);
    expect(out.staticPrefix).toContain("Write policy");
    expect(out.staticPrefix).toMatch(/only.*explicitly asked/i);
    expect(out.staticPrefix).toContain("lasting conventions");
    expect(out.staticPrefix).toContain("one-off task decisions");
  });

  it("omits the memory block when there is nothing to advertise", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.dynamicSuffix).not.toContain("<memory>");
    expect(out.dynamicSuffix).not.toContain("no memory files yet");
  });

  it("uses open-set safety wording (examples, not an exhaustive path list)", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.staticPrefix).toContain("similar paths");
    expect(out.staticPrefix).toContain("non-exhaustive");
    expect(out.staticPrefix).toMatch(/Content rule/);
    expect(out.staticPrefix).toMatch(/similar high-risk/);
    expect(out.staticPrefix).not.toContain("`/etc/shadow`");
  });

  it("does not inject a redundant platform field alongside os", async () => {
    const out = await buildSystemPrompt(baseCtx);
    expect(out.stableContext).toMatch(/^os:/m);
    expect(out.stableContext).not.toMatch(/^platform:/m);
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

  it("omits the plan block entirely when no plan exists", async () => {
    const out = await buildSystemPrompt({ ...baseCtx, plan: undefined });
    expect(out.volatileSuffix).not.toContain("<plan>");
    expect(out.volatileSuffix).not.toContain("plan_update");
    expect(out.volatileSuffix).toContain("now:");
  });

  it("keeps the stable context byte-identical when only volatile state changes", async () => {
    // Two snapshots differing ONLY in `now` and plan — the stable context must
    // stay byte-for-byte identical so the cached system block never busts.
    const mk = (now: string, plan: typeof baseCtx.plan) => ({
      ...baseCtx,
      plan,
      environmentProvider: {
        async snapshot(cwd: string) {
          return {
            os: "x", hostname: "h", user: "u", shell: "/bin/sh", node: "v0", cwd,
            now, timezone: "UTC",
            git: { inRepo: true, root: "/w", branch: "main", lastCommitSha: "abc", lastCommit: "wip" },
          };
        },
      } as EnvironmentProvider,
    });
    const a = await buildSystemPrompt(mk("2026-01-01T00:00:00Z", []));
    const b = await buildSystemPrompt(mk("2026-06-30T23:59:59Z", [
      { id: "s", title: "work", status: "in_progress" },
    ]));
    expect(a.staticPrefix).toBe(b.staticPrefix);
    expect(a.stableContext).toBe(b.stableContext); // ← the invariant
    // And the volatile tiers DO differ (sanity: we didn't accidentally freeze them).
    expect(a.volatileSuffix).not.toBe(b.volatileSuffix);
    expect(a.volatileSuffix).toContain("2026-01-01T00:00:00Z");
    expect(b.volatileSuffix).toContain("2026-06-30T23:59:59Z");
    expect(b.volatileSuffix).toContain("work");
  });

  it("does not duplicate a tool list in the suffix (names live in the tools array)", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["bash", "edit_file"],
    });
    // The redundant <tools> block was removed to avoid re-listing tools every
    // turn (grows with MCP). The static prefix no longer enumerates them either
    // — each tool's own description plus the provider `tools` array is the manual.
    expect(out.dynamicSuffix).not.toContain("<tools>");
    expect(out.staticPrefix).not.toMatch(/Available tools:/);
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
      expect(out.staticPrefix, `identity missing in ${mode}`).toContain("CodePilot — Software Engineering Agent");
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
    expect(out.staticPrefix).toContain("≥3 mutate/verify/decision steps");
    // The planning rule no longer hinges on the undecidable "non-trivial".
    const planStart = out.staticPrefix.indexOf("## Planning and Task State");
    expect(planStart, "Planning section not found").toBeGreaterThanOrEqual(0);
    const planEnd = out.staticPrefix.indexOf("\n## ", planStart + 1);
    const planBlock = out.staticPrefix.slice(planStart, planEnd);
    expect(planBlock).not.toMatch(/non-trivial task/);
  });

  // Re-read-when-gone / unread-after-compaction lives once in Tool-Use Policy.
  it("dedup: the unread-after-compaction re-read rule appears once", async () => {
    const out = await buildSystemPrompt({
      ...baseCtx,
      toolNames: ["read_file", "edit_file", "bash", "read_artifact"],
    });
    const unreadMentions = out.staticPrefix.match(/treat as \*\*unread\*\*/g) ?? [];
    expect(unreadMentions.length).toBe(1);
    expect(out.staticPrefix).toMatch(/Do not yield early just to wait/);
    expect(out.staticPrefix).toMatch(/User messages this turn are instructions/);
    expect(out.staticPrefix).toMatch(/Ask when the answer would change the plan or risk profile/);
  });
});

// The Section registry enforces (not just documents) uniqueness,
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
