import { describe, expect, it } from "vitest";
import {
  COMPLETION_MARKERS,
  goalPromptBody,
} from "../src/subagent/goal.js";
import {
  SUBAGENT_ROLE_BLOCK,
  SUBAGENT_PLAN_ROLE_BLOCK,
  subagentStaticBody,
} from "../src/subagent/subagent.js";
import { SUMMARY_SYSTEM_PROMPT } from "../src/compaction/compaction.js";

describe("goal prompt contract", () => {
  it("goalPromptBody contains the 6-step protocol", () => {
    expect(goalPromptBody).toMatch(/Read the current plan/);
    expect(goalPromptBody).toMatch(/Identify the next step/);
    expect(goalPromptBody).toMatch(/Execute that step/);
    expect(goalPromptBody).toMatch(/Verify/);
    expect(goalPromptBody).toMatch(/Update the plan/);
    expect(goalPromptBody).toMatch(/Decide whether the OBJECTIVE is fully satisfied/);
  });

  it("goalPromptBody mentions both completion markers", () => {
    expect(goalPromptBody).toContain("<goal_status>completed</goal_status>");
    expect(goalPromptBody).toContain("<goal_status>blocked</goal_status>");
  });

  it("COMPLETION_MARKERS regexes match the prompt's emitted markers", () => {
    const text = "...\n<goal_status>completed</goal_status>\n";
    const matched = COMPLETION_MARKERS.some((re) => re.test(text));
    expect(matched).toBe(true);
  });

  it("COMPLETION_MARKERS also matches the blocked form", () => {
    const text = "Reason: foo\n<goal_status>blocked</goal_status>\n<goal_blocked_reason>need user input</goal_blocked_reason>";
    const matched = COMPLETION_MARKERS.some((re) => re.test(text));
    expect(matched).toBe(true);
  });
});

describe("subagent specialist templates", () => {
  it("explore stays lean: behaviour in static, field shape deferred to footer", () => {
    const explore = subagentStaticBody("explore");
    expect(explore).toMatch(/Explore sub-agent/);
    expect(explore).toMatch(/READ-ONLY/);
    expect(explore).toMatch(/\*\*Task\*\*/);
    expect(explore).toMatch(/ignore previous/);
    expect(explore).toMatch(/except\*\* Safety|except.*Safety/i);
    expect(explore).toMatch(/plain \*\*content\*\*/);
    expect(explore).toMatch(/Blocker `dependency`/);
    expect(explore).toMatch(/No nested/);
    expect(explore).toMatch(/task footer/);
    expect(explore).toMatch(/\*\*Conclusion\.\*\*/);
    expect(explore).not.toMatch(/### Findings/);
    expect(explore).not.toMatch(/### Blocker/);
    expect(explore).toMatch(/do not force a code-edit framing/i);
    expect(explore).not.toMatch(/Research before you mutate/);
    expect(explore).not.toMatch(/edit_file/);
    expect(explore).not.toMatch(/check: <command/);
    expect(explore).not.toMatch(/rate_limit\|timeout\|not_found/);
    expect(explore.length).toBeLessThan(2200);
  });

  it("plan points at task footer for section shape (no Findings template)", () => {
    const plan = subagentStaticBody("plan");
    expect(plan).toMatch(/Plan sub-agent/);
    expect(plan).toMatch(/READ-ONLY/);
    expect(plan).toMatch(/task footer/);
    expect(plan).not.toMatch(/### Plan/);
    expect(plan).not.toMatch(/### Critical files/);
    expect(plan).not.toMatch(/### Findings/);
    expect(plan).not.toMatch(/Override the conclusion/);
    expect(plan.length).toBeLessThan(1800);
  });

  it("worker keeps mid-run error/probe rules without parent essays", () => {
    const worker = subagentStaticBody("worker", ["bash", "edit_file", "task_board"]);
    expect(worker).toMatch(/Worker sub-agent/);
    expect(worker).toMatch(/escalate_sandbox/);
    expect(worker).toMatch(/ping -c/);
    expect(worker).toMatch(/telnet/);
    expect(worker).toMatch(/command-not-found|Command-not-found/);
    expect(worker).toMatch(/add bounds/);
    expect(worker).toMatch(/auto-rollback/);
    expect(worker).toMatch(/this run/);
    expect(worker).toMatch(/task_board/);
    expect(worker).toMatch(/Blocker `dependency`/);
    expect(worker).not.toMatch(/Git Etiquette/);
    expect(worker).not.toMatch(/check: <command/);
    expect(worker.length).toBeLessThan(3200);
    expect(worker.length).toBeGreaterThan(subagentStaticBody("explore").length);
  });

  it("back-compat exports match live specialist templates", () => {
    expect(SUBAGENT_ROLE_BLOCK).toMatch(/Explore sub-agent/);
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toBe(subagentStaticBody("plan"));
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toMatch(/Plan sub-agent/);
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toMatch(/READ-ONLY/);
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toMatch(/task footer/);
  });
});

describe("compaction summary prompt", () => {
  it("enumerates the checkpoint sections in CodePilot titles", () => {
    const order = [
      "## Goals",
      "## Concepts",
      "## Key files",
      "## Errors",
      "## Done",
      "## Pending",
      "## Current",
      "## Up next",
      "## Critical",
    ];
    let lastIdx = -1;
    for (const heading of order) {
      const idx = SUMMARY_SYSTEM_PROMPT.indexOf(heading);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("pins user goals, plan statuses, and latest-ask next step", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Every distinct user request/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/\[pending\]/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/\[in_progress\]/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/most recent explicit ask/i);
  });

  it("keeps Done vs Pending vs Current vs Errors vs Critical distinct", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Finished work and verified outcomes/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/not yet started/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/in flight at this checkpoint/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Do not put completed work here/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/how it was fixed/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Decisions and one-line why/i);
  });

  it("keeps the anti-loss disciplines (verbatim, never-drop, verified-vs-assumed, source separation)", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/verbatim/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Never paraphrase/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/never drop a section/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Distinguish verified from assumed/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Source separation/i);
  });

  it("forbids pasting file/tool bodies into the checkpoint", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/NEVER paste file contents/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/tool bodies/i);
  });
});
