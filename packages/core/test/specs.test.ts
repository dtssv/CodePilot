// Spec-driven-development artifact discovery + coverage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  specsDir,
  listSpecFeatures,
  readSpecFeature,
  parseAcceptanceCriteria,
  parseTasks,
  specCoverage,
} from "../src/specs.js";

describe("specsDir", () => {
  it("defaults to <cwd>/.codepilot/specs", () => {
    expect(specsDir("/repo")).toBe(join("/repo", ".codepilot", "specs"));
  });
  it("honours an absolute override", () => {
    expect(specsDir("/repo", "/elsewhere/specs")).toBe("/elsewhere/specs");
  });
  it("resolves a relative override against cwd", () => {
    expect(specsDir("/repo", "docs/specs")).toBe(join("/repo", "docs", "specs"));
  });
});

describe("parseAcceptanceCriteria", () => {
  it("pulls numbered AC-x.y ids and their text", () => {
    const text = [
      "### R1 — login",
      "- AC-1.1: WHEN the user submits valid creds THE SYSTEM SHALL start a session.",
      "- AC-1.2: IF creds are wrong THEN THE SYSTEM SHALL reject with a 401.",
      "### R2 — logout",
      "- AC-2.1: THE SYSTEM SHALL clear the session cookie.",
    ].join("\n");
    const acs = parseAcceptanceCriteria(text);
    expect(acs.map((a) => a.id)).toEqual(["AC-1.1", "AC-1.2", "AC-2.1"]);
    expect(acs[0]!.text).toMatch(/start a session/);
  });
});

describe("parseTasks", () => {
  it("parses checkbox tasks with verify command and closed ACs", () => {
    const text = [
      "## Tasks",
      "- [x] T1 — add the login route",
      "  - Does: wire POST /login",
      "  - verify: `pnpm test login.test.ts` → AC-1.1, AC-1.2",
      "- [ ] T2 — add logout",
      "  - verify: pnpm test logout.test.ts → AC-2.1",
      "- [ ] T3 — docs (no verify yet)",
    ].join("\n");
    const tasks = parseTasks(text);
    expect(tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    expect(tasks[0]!.done).toBe(true);
    expect(tasks[1]!.done).toBe(false);
    expect(tasks[0]!.verifyCommand).toBe("pnpm test login.test.ts");
    expect(tasks[0]!.closesAcceptanceCriteria).toEqual(["AC-1.1", "AC-1.2"]);
    expect(tasks[1]!.closesAcceptanceCriteria).toEqual(["AC-2.1"]);
    expect(tasks[2]!.verifyCommand).toBeUndefined();
  });
});

describe("specCoverage", () => {
  it("separates covered from uncovered ACs and flags tasks without verify", () => {
    const feature = {
      slug: "login",
      dir: "/x",
      hasRequirements: true,
      hasDesign: true,
      hasTasks: true,
      acceptanceCriteria: [
        { id: "AC-1.1", text: "a" },
        { id: "AC-1.2", text: "b" },
        { id: "AC-2.1", text: "c" },
      ],
      tasks: [
        { id: "T1", title: "x", done: true, verifyCommand: "pnpm test", closesAcceptanceCriteria: ["AC-1.1"] },
        { id: "T2", title: "y", done: false, closesAcceptanceCriteria: [] },
      ],
      updatedAt: 0,
    };
    const cov = specCoverage(feature);
    expect(cov.covered).toEqual(["AC-1.1"]);
    expect(cov.uncovered).toEqual(["AC-1.2", "AC-2.1"]);
    expect(cov.tasksWithoutVerify).toEqual(["T2"]);
  });
});

describe("discovery on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "specs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a feature folder and lists features newest-first", async () => {
    const root = join(dir, ".codepilot", "specs");
    mkdirSync(join(root, "alpha"), { recursive: true });
    writeFileSync(
      join(root, "alpha", "requirements.md"),
      "# Requirements: alpha\n- AC-1.1: THE SYSTEM SHALL work.\n",
      "utf-8",
    );
    writeFileSync(
      join(root, "alpha", "tasks.md"),
      "- [ ] T1 — do it\n  - verify: pnpm test → AC-1.1\n",
      "utf-8",
    );

    const one = await readSpecFeature(dir, "alpha");
    expect(one?.hasRequirements).toBe(true);
    expect(one?.hasDesign).toBe(false);
    expect(one?.hasTasks).toBe(true);
    expect(one?.acceptanceCriteria.map((a) => a.id)).toEqual(["AC-1.1"]);
    expect(one?.tasks[0]!.closesAcceptanceCriteria).toEqual(["AC-1.1"]);

    const all = await listSpecFeatures(dir);
    expect(all.map((f) => f.slug)).toEqual(["alpha"]);
  });

  it("returns undefined for an empty/missing feature and [] for a missing root", async () => {
    expect(await readSpecFeature(dir, "nope")).toBeUndefined();
    expect(await listSpecFeatures(dir)).toEqual([]);
  });
});
