import { describe, expect, it } from "vitest";
import {
  COMPLETION_MARKERS,
  goalPromptBody,
} from "../src/goal.js";
import { SUBAGENT_ROLE_BLOCK } from "../src/subagent.js";
import { SUMMARY_SYSTEM_PROMPT } from "../src/compaction.js";

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

describe("subagent role block", () => {
  it("makes the role boundary explicit", () => {
    expect(SUBAGENT_ROLE_BLOCK).toMatch(/Sub-Agent Role/);
    expect(SUBAGENT_ROLE_BLOCK).toMatch(/NOT the user's assistant/);
    expect(SUBAGENT_ROLE_BLOCK).toMatch(/No nested sub-agents/);
  });

  it("specifies the structured conclusion format", () => {
    expect(SUBAGENT_ROLE_BLOCK).toContain("### Findings");
    expect(SUBAGENT_ROLE_BLOCK).toContain("### Key references");
    expect(SUBAGENT_ROLE_BLOCK).toContain("### Recommendations");
    expect(SUBAGENT_ROLE_BLOCK).toContain("### Blocker");
  });

  it("enumerates the read-only default tool set", () => {
    expect(SUBAGENT_ROLE_BLOCK).toContain("read_file");
    expect(SUBAGENT_ROLE_BLOCK).toContain("grep");
    expect(SUBAGENT_ROLE_BLOCK).toContain("glob");
    expect(SUBAGENT_ROLE_BLOCK).toContain("read_artifact");
  });
});

describe("compaction summary prompt", () => {
  it("enumerates the seven required sections in order", () => {
    const order = [
      "TASK OVERVIEW",
      "CURRENT STATE",
      "KEY FILES AND SYMBOLS",
      "DECISIONS MADE",
      "ERRORS AND FIXES",
      "OPEN THREADS",
      "NEXT CONCRETE ACTION",
    ];
    let lastIdx = -1;
    for (const heading of order) {
      const idx = SUMMARY_SYSTEM_PROMPT.indexOf(heading);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("instructs preservation of verbatim literals", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/verbatim/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Never paraphrase/);
  });
});
