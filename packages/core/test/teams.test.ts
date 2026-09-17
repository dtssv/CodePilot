// Agent Teams (ROADMAP-NEXT §4.2). The SubagentRunner is faked: these tests
// are about orchestration — decomposition, parallelism, conflict detection,
// merge strategies, team_message narration — not about model behaviour.

import { describe, expect, it } from "vitest";

import {
  runTeam,
  validateTeam,
  nameMembers,
  detectConflicts,
  writtenPath,
  concatSummary,
  parseAssignments,
  parseVote,
  renderTeamResult,
  type TeamMemberResult,
  type TeamSpec,
} from "../src/teams.js";
import type { SubagentRunner, SubagentRunSpec } from "../src/tools/task.js";
import type { Event, TeamMessageEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

interface FakeRunnerOptions {
  /** conclusion per call, matched by objective substring; else `fallback`. */
  replies?: Array<{ match: RegExp; conclusion: string }>;
  fallback?: string;
  /** Simulate write_file tool calls, keyed by objective substring. */
  writes?: Array<{ match: RegExp; files: string[] }>;
  /** Objectives matching this reject. */
  failOn?: RegExp;
  /** Record concurrency: max simultaneous runs observed. */
  track?: { active: number; max: number; order: string[] };
}

function fakeRunner(opts: FakeRunnerOptions = {}): SubagentRunner & {
  calls: SubagentRunSpec[];
} {
  const calls: SubagentRunSpec[] = [];
  return {
    calls,
    async run(spec: SubagentRunSpec) {
      calls.push(spec);
      if (opts.track) {
        opts.track.active++;
        opts.track.max = Math.max(opts.track.max, opts.track.active);
        opts.track.order.push(spec.objective.slice(0, 24));
      }
      try {
        // Yield so parallel runs actually overlap.
        await new Promise((r) => setTimeout(r, 1));
        if (opts.failOn?.test(spec.objective)) {
          throw new Error("member exploded");
        }
        for (const w of opts.writes ?? []) {
          if (w.match.test(spec.objective)) {
            for (const f of w.files) {
              spec.onEvent?.({
                type: "tool_call",
                id: `tc_${f}`,
                name: "write_file",
                input: { path: f, content: "x" },
              } as Event);
            }
          }
        }
        for (const r of opts.replies ?? []) {
          if (r.match.test(spec.objective)) {
            return { conclusion: r.conclusion, steps: 3 };
          }
        }
        return { conclusion: opts.fallback ?? "done", steps: 1 };
      } finally {
        if (opts.track) opts.track.active--;
      }
    },
  };
}

function collectEvents(): { events: Event[]; emitEvent: (e: Event) => void } {
  const events: Event[] = [];
  return { events, emitEvent: (e) => void events.push(e) };
}

function teamMessages(events: Event[]): TeamMessageEvent[] {
  return events.filter((e): e is TeamMessageEvent => e.type === "team_message");
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("validateTeam", () => {
  const ok: TeamSpec = {
    objective: "goal",
    members: [{ role: "worker", objective: "a" }],
  };

  it("accepts a minimal team", () => {
    expect(validateTeam(ok)).toBeNull();
  });

  it("rejects an empty team", () => {
    expect(validateTeam({ members: [] })).toMatch(/no members/);
  });

  it("rejects more than one leader", () => {
    expect(
      validateTeam({
        objective: "g",
        members: [{ role: "leader" }, { role: "leader" }, { role: "worker" }],
      }),
    ).toMatch(/2 leaders/);
  });

  it("rejects a leader with nobody to lead", () => {
    expect(validateTeam({ objective: "g", members: [{ role: "leader" }] })).toMatch(
      /only a leader/,
    );
  });

  it("rejects an oversized team", () => {
    expect(
      validateTeam({
        objective: "g",
        members: Array.from({ length: 9 }, () => ({ role: "worker" as const, objective: "x" })),
      }),
    ).toMatch(/maximum is 8/);
  });

  it("requires either per-member objectives or a leader plus a team objective", () => {
    expect(validateTeam({ members: [{ role: "worker" }, { role: "worker" }] })).toMatch(
      /every member needs an `objective`/,
    );
    // A leader + team objective is enough.
    expect(
      validateTeam({
        objective: "g",
        members: [{ role: "leader" }, { role: "worker" }],
      }),
    ).toBeNull();
  });
});

describe("nameMembers", () => {
  it("numbers members per role", () => {
    expect(
      nameMembers([
        { role: "leader" },
        { role: "worker" },
        { role: "worker" },
        { role: "specialist" },
      ]),
    ).toEqual(["leader-1", "worker-1", "worker-2", "specialist-1"]);
  });

  it("keeps explicit names and de-duplicates collisions", () => {
    expect(
      nameMembers([
        { role: "worker", name: "frontend" },
        { role: "worker", name: "frontend" },
        { role: "worker" },
      ]),
    ).toEqual(["frontend", "frontend#2", "worker-1"]);
  });
});

describe("writtenPath", () => {
  it("extracts the path from write-tool calls", () => {
    expect(writtenPath("write_file", { path: "a.ts" })).toBe("a.ts");
    expect(writtenPath("edit_file", { file_path: "b.ts" })).toBe("b.ts");
    expect(writtenPath("apply_patch", { path: " c.ts " })).toBe("c.ts");
    expect(writtenPath("notebook_edit", { notebook_path: "n.ipynb" })).toBe("n.ipynb");
  });

  it("ignores read-only tools and pathless inputs", () => {
    expect(writtenPath("read_file", { path: "a.ts" })).toBeNull();
    expect(writtenPath("bash", { command: "rm x" })).toBeNull();
    expect(writtenPath("write_file", { content: "x" })).toBeNull();
    expect(writtenPath("write_file", null)).toBeNull();
  });
});

describe("detectConflicts", () => {
  const member = (name: string, files: string[]): TeamMemberResult => ({
    name,
    role: "worker",
    objective: "o",
    conclusion: "c",
    steps: 1,
    ok: true,
    filesTouched: files,
  });

  it("reports files written by more than one member", () => {
    const conflicts = detectConflicts([
      member("a", ["src/x.ts", "src/y.ts"]),
      member("b", ["src/y.ts", "src/z.ts"]),
      member("c", ["src/y.ts"]),
    ]);
    expect(conflicts).toEqual([{ file: "src/y.ts", members: ["a", "b", "c"] }]);
  });

  it("finds nothing when members stay in their lanes", () => {
    expect(detectConflicts([member("a", ["x.ts"]), member("b", ["y.ts"])])).toEqual([]);
  });

  it("does not flag one member touching a file twice", () => {
    expect(detectConflicts([member("a", ["x.ts", "x.ts"])])).toEqual([]);
  });
});

describe("parseAssignments", () => {
  it("parses a fenced JSON assignment list", () => {
    const m = parseAssignments(
      '```json\n{"assignments":[{"member":"worker-1","objective":"do A"},' +
        '{"member":"worker-2","objective":"do B"}]}\n```',
    );
    expect(m.get("worker-1")).toBe("do A");
    expect(m.get("worker-2")).toBe("do B");
  });

  it("skips malformed and empty entries", () => {
    const m = parseAssignments(
      '{"assignments":[{"member":"a","objective":""},{"member":"b"},{"objective":"x"},' +
        '{"member":"c","objective":"real"}]}',
    );
    expect(m.size).toBe(1);
    expect(m.get("c")).toBe("real");
  });

  it("returns empty for unparseable output", () => {
    expect(parseAssignments("I could not decide").size).toBe(0);
  });
});

describe("parseVote", () => {
  it("parses a vote", () => {
    const v = parseVote('{"winner":"w-2","rationale":"best evidence","agreed_with_winner":["w-3"]}');
    expect(v).toEqual({ winner: "w-2", rationale: "best evidence", agreedWith: ["w-3"] });
  });

  it("defaults a missing rationale", () => {
    expect(parseVote('{"winner":"w-1"}')?.rationale).toBe("(no rationale given)");
  });

  it("rejects a vote with no winner", () => {
    expect(parseVote('{"rationale":"hmm"}')).toBeNull();
    expect(parseVote("no json here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe("runTeam", () => {
  it("runs members in parallel with their own objectives and concatenates", async () => {
    const track = { active: 0, max: 0, order: [] as string[] };
    const runner = fakeRunner({
      track,
      replies: [
        { match: /frontend/, conclusion: "FE done" },
        { match: /backend/, conclusion: "BE done" },
      ],
    });
    const { events, emitEvent } = collectEvents();
    const result = await runTeam(
      {
        objective: "ship the feature",
        members: [
          { role: "worker", name: "fe", objective: "do the frontend" },
          { role: "worker", name: "be", objective: "do the backend" },
        ],
      },
      { runner, cwd: "/repo", emitEvent },
    );

    expect(track.max).toBe(2); // actually parallel
    expect(result.mergeStrategy).toBe("concat"); // no leader → concat
    expect(result.members.map((m) => m.name)).toEqual(["fe", "be"]);
    expect(result.summary).toMatch(/FE done/);
    expect(result.summary).toMatch(/BE done/);
    expect(result.conflicts).toEqual([]);

    // Each member's conclusion is narrated, plus the final summary.
    const kinds = teamMessages(events).map((m) => m.kind);
    expect(kinds.filter((k) => k === "conclusion")).toHaveLength(2);
    expect(kinds.filter((k) => k === "summary")).toHaveLength(1);
  });

  it("has the leader decompose the goal into assignments", async () => {
    const runner = fakeRunner({
      replies: [
        {
          match: /LEADER of an agent team working on this goal/,
          conclusion:
            '{"assignments":[{"member":"fe","objective":"build the form"},' +
            '{"member":"be","objective":"add the endpoint"}]}',
        },
        { match: /LEADER of an agent team\. The team's goal/, conclusion: "TEAM REPORT" },
        { match: /build the form/, conclusion: "form built" },
        { match: /add the endpoint/, conclusion: "endpoint added" },
      ],
    });
    const { events, emitEvent } = collectEvents();
    const result = await runTeam(
      {
        objective: "add a signup flow",
        members: [
          { role: "leader", name: "lead" },
          { role: "worker", name: "fe" },
          { role: "worker", name: "be" },
        ],
      },
      { runner, cwd: "/repo", emitEvent },
    );

    // Leader decomposition + 2 members + leader summary = 4 runs.
    expect(runner.calls).toHaveLength(4);
    expect(result.members.map((m) => m.objective)).toEqual([
      "build the form",
      "add the endpoint",
    ]);
    expect(result.mergeStrategy).toBe("leader_summary");
    expect(result.summary).toBe("TEAM REPORT");
    expect(result.notes).toEqual([]);

    // Assignments are addressed to the right members.
    const assignments = teamMessages(events).filter((m) => m.kind === "assignment");
    expect(assignments.map((a) => a.to)).toEqual(["fe", "be"]);
    expect(assignments[0]?.from).toBe("lead");

    // The leader plans read-only; workers may write.
    expect(runner.calls[0]?.agentType).toBe("explore");
    expect(runner.calls.slice(1, 3).map((c) => c.agentType)).toEqual(["worker", "worker"]);
  });

  it("keeps explicit member objectives and only assigns the rest", async () => {
    const runner = fakeRunner({
      replies: [
        {
          match: /NEEDS-ASSIGNMENT/,
          conclusion: '{"assignments":[{"member":"be","objective":"assigned work"}]}',
        },
        { match: /goal/, conclusion: "report" },
      ],
      fallback: "member done",
    });
    const result = await runTeam(
      {
        objective: "goal",
        members: [
          { role: "leader", name: "lead" },
          { role: "worker", name: "fe", objective: "my own work" },
          { role: "worker", name: "be" },
        ],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.members.map((m) => m.objective)).toEqual([
      "my own work",
      "assigned work",
    ]);
    // The roster tells the leader which member is already covered.
    expect(runner.calls[0]?.objective).toMatch(/fe \(worker\): already assigned/);
    expect(runner.calls[0]?.objective).toMatch(/be \(worker\): NEEDS-ASSIGNMENT/);
  });

  it("falls back to the team objective when the leader assigns nobody", async () => {
    const runner = fakeRunner({
      replies: [{ match: /NEEDS-ASSIGNMENT/, conclusion: "I have no idea" }],
      fallback: "done anyway",
    });
    const result = await runTeam(
      {
        objective: "the shared goal",
        members: [{ role: "leader" }, { role: "worker", name: "w" }],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.members[0]?.objective).toBe("the shared goal");
    expect(result.notes.join(" ")).toMatch(/leader did not produce an assignment for w/);
  });

  it("detects two members writing the same file", async () => {
    const runner = fakeRunner({
      writes: [
        { match: /frontend/, files: ["src/api.ts", "src/ui.tsx"] },
        { match: /backend/, files: ["src/api.ts"] },
      ],
    });
    const { events, emitEvent } = collectEvents();
    const result = await runTeam(
      {
        objective: "g",
        members: [
          { role: "worker", name: "fe", objective: "frontend bits" },
          { role: "worker", name: "be", objective: "backend bits" },
        ],
      },
      { runner, cwd: "/repo", emitEvent },
    );

    expect(result.conflicts).toEqual([{ file: "src/api.ts", members: ["be", "fe"] }]);
    expect(result.summary).toMatch(/File conflicts/);
    expect(result.summary).toMatch(/src\/api\.ts/);
    const conflictMsg = teamMessages(events).find((m) => m.kind === "conflict");
    expect(conflictMsg?.content).toMatch(/src\/api\.ts: be, fe/);
  });

  it("surfaces a failed member without failing the team", async () => {
    const runner = fakeRunner({ failOn: /break/, fallback: "fine" });
    const result = await runTeam(
      {
        objective: "g",
        members: [
          { role: "worker", name: "good", objective: "work" },
          { role: "worker", name: "bad", objective: "break things" },
        ],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.members.map((m) => m.ok)).toEqual([true, false]);
    expect(result.summary).toMatch(/FAILED: member exploded/);
  });

  it("picks a winner under the voting strategy", async () => {
    const runner = fakeRunner({
      replies: [
        { match: /which single answer/, conclusion: '{"winner":"b","rationale":"most evidence","agreed_with_winner":["c"]}' },
        { match: /same question/, conclusion: "answer" },
      ],
      fallback: "an answer",
    });
    const result = await runTeam(
      {
        objective: "which cache should we use",
        merge_strategy: "voting",
        members: [
          { role: "specialist", name: "a", objective: "same question, angle 1" },
          { role: "specialist", name: "b", objective: "same question, angle 2" },
          { role: "specialist", name: "c", objective: "same question, angle 3" },
        ],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.mergeStrategy).toBe("voting");
    expect(result.summary).toMatch(/\*\*b\*\* wins \(2\/3 in agreement\)/);
    expect(result.summary).toMatch(/most evidence/);
    // No leader in the team, so an implicit judge was used — and said so.
    expect(result.notes.join(" ")).toMatch(/implicit read-only team-judge/);
  });

  it("falls back to concat when a vote cannot be resolved", async () => {
    const runner = fakeRunner({
      replies: [{ match: /which single answer/, conclusion: '{"winner":"nobody"}' }],
      fallback: "an answer",
    });
    const result = await runTeam(
      {
        objective: "q",
        merge_strategy: "voting",
        members: [
          { role: "worker", name: "a", objective: "x" },
          { role: "worker", name: "b", objective: "y" },
        ],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.mergeStrategy).toBe("concat");
    expect(result.notes.join(" ")).toMatch(/vote result was unusable/);
  });

  it("refuses to vote with fewer than two successful members", async () => {
    const runner = fakeRunner({ failOn: /break/, fallback: "ok" });
    const result = await runTeam(
      {
        objective: "q",
        merge_strategy: "voting",
        members: [
          { role: "worker", name: "a", objective: "work" },
          { role: "worker", name: "b", objective: "break" },
        ],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.mergeStrategy).toBe("concat");
    expect(result.notes.join(" ")).toMatch(/voting needs at least 2 successful members/);
  });

  it("falls back to concat when the leader summary fails", async () => {
    const runner = fakeRunner({
      replies: [
        { match: /LEADER of an agent team\. The team's goal/, conclusion: "x" },
      ],
      failOn: /The team's goal was/,
      fallback: "member output",
    });
    const result = await runTeam(
      {
        objective: "g",
        members: [{ role: "leader" }, { role: "worker", name: "w", objective: "work" }],
      },
      { runner, cwd: "/repo" },
    );
    expect(result.mergeStrategy).toBe("concat");
    expect(result.notes.join(" ")).toMatch(/leader summary failed/);
    expect(result.summary).toMatch(/member output/);
  });

  it("respects the shared semaphore", async () => {
    const track = { active: 0, max: 0, order: [] as string[] };
    const runner = fakeRunner({ track, fallback: "done" });
    let held = 0;
    const semaphore = {
      async withPermit<T>(fn: () => Promise<T>): Promise<T> {
        held++;
        try {
          return await fn();
        } finally {
          held--;
        }
      },
    };
    await runTeam(
      {
        objective: "g",
        members: [
          { role: "worker", name: "a", objective: "a" },
          { role: "worker", name: "b", objective: "b" },
        ],
      },
      { runner, cwd: "/repo", semaphore },
    );
    expect(held).toBe(0); // every permit released
    expect(track.max).toBe(2);
  });

  it("notes a shared worktree that could not be created", async () => {
    const runner = fakeRunner({ fallback: "done" });
    const result = await runTeam(
      {
        objective: "g",
        shared_worktree: true,
        members: [{ role: "worker", name: "w", objective: "work" }],
      },
      // Not a git repo: worktree creation fails and members run in the cwd.
      { runner, cwd: "/nonexistent-path-for-team-test" },
    );
    expect(result.worktree).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/shared worktree unavailable/);
    expect(runner.calls[0]?.cwd).toBe("/nonexistent-path-for-team-test");
  });

  it("rejects an invalid team before running anything", async () => {
    const runner = fakeRunner();
    await expect(
      runTeam({ members: [{ role: "leader" }] }, { runner, cwd: "/repo" }),
    ).rejects.toThrow(/only a leader/);
    expect(runner.calls).toHaveLength(0);
  });

  it("skips the model-driven merge when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = fakeRunner({ fallback: "done" });
    const result = await runTeam(
      {
        objective: "g",
        members: [{ role: "leader" }, { role: "worker", name: "w", objective: "work" }],
      },
      { runner, cwd: "/repo", signal: controller.signal },
    );
    // No decomposition pass, no summary pass — just the member runs.
    expect(result.mergeStrategy).toBe("concat");
    expect(runner.calls).toHaveLength(1);
  });
});

describe("renderTeamResult", () => {
  it("leads with the outcome and appends notes", () => {
    const text = renderTeamResult({
      members: [
        { name: "a", role: "worker", objective: "o", conclusion: "c", steps: 2, ok: true, filesTouched: [] },
        { name: "b", role: "worker", objective: "o", conclusion: "c", steps: 0, ok: false, filesTouched: [] },
      ],
      conflicts: [{ file: "x.ts", members: ["a", "b"] }],
      summary: "THE SUMMARY",
      mergeStrategy: "leader_summary",
      notes: ["something degraded"],
    });
    expect(text).toMatch(/1\/2 members succeeded/);
    expect(text).toMatch(/merge strategy "leader_summary"/);
    expect(text).toMatch(/1 file conflict/);
    expect(text).toMatch(/THE SUMMARY/);
    expect(text).toMatch(/- something degraded/);
  });

  it("reports the worktree branch when there was one", () => {
    const text = renderTeamResult({
      members: [],
      conflicts: [],
      summary: "s",
      mergeStrategy: "concat",
      worktree: { path: "/tmp/wt", branch: "cp-team-1", diffStat: " 2 files changed" },
      notes: [],
    });
    expect(text).toMatch(/branch cp-team-1/);
    expect(text).toMatch(/2 files changed/);
  });
});

describe("concatSummary", () => {
  it("labels each member and appends conflicts", () => {
    const text = concatSummary(
      [
        { name: "a", role: "worker", objective: "do a", conclusion: "A!", steps: 1, ok: true, filesTouched: [] },
      ],
      [{ file: "f.ts", members: ["a", "b"] }],
    );
    expect(text).toMatch(/### a \(worker\) — 1 step/);
    expect(text).toMatch(/_Objective:_ do a/);
    expect(text).toMatch(/A!/);
    expect(text).toMatch(/`f\.ts` — a, b/);
  });
});
